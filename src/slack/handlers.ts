import { z } from 'zod';
import type { Clock } from '../clock.js';
import { getFlashcard } from '../db/flashcards.js';
import { findUserBySlackId } from '../db/users.js';
import { InvalidOptionError, previewAnswer, submitAnswer, type RejectReason } from '../services/answer.js';
import { afterAnswer, type SchedulerDeps } from '../services/scheduler.js';
import {
  ERROR_TEXT,
  buildRatedMessage,
  buildRatingMessage,
  buildRejectionMessage,
  buildWrongMessage,
  type CardMessage,
  type Rating,
} from './card.js';

export const answerValue = z.object({ c: z.string(), o: z.number().int().min(0).nullable() });
export const rateValue = z.object({ c: z.string(), o: z.number().int().min(0), r: z.enum(['hard', 'medium', 'easy']) });

// Button values come from the client: never throw, return null for anything malformed.
export function parseValue<T>(schema: z.ZodType<T>, raw: unknown): T | null {
  if (typeof raw !== 'string') return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export const rawValue = (action: object): unknown => ('value' in action ? action.value : undefined);

/** The part of Bolt's action args the handlers use; Bolt's own args are assignable to it. */
export interface ClickArgs {
  ack: () => Promise<unknown>;
  action: { action_id: string };
  /** `message.ts` is the Slack message the button is on. */
  body: { user: { id: string }; message?: { ts?: string } };
  respond: (message: { text: string; blocks?: CardMessage['blocks']; replace_original: boolean; response_type?: 'ephemeral' }) => Promise<unknown>;
}

export interface ActionRouter {
  action(pattern: RegExp, handler: (args: ClickArgs) => Promise<void>): unknown;
}

const replace = (respond: ClickArgs['respond'], m: CardMessage) => respond({ ...m, replace_original: true });

/** Only ids and codes are logged: never the payload, the value or a token. An error is logged by name, since driver messages carry query parameters. */
const errName = (e: unknown) => (e instanceof Error ? e.name : 'unknown');

/**
 * The two button handlers of docs/slack/integration.md, over the real services. `ack()` is the first statement. The clicking
 * Slack user is mapped to our user by `slack_id`; the answer service then refuses unless that user is enrolled and the card
 * is open for them (`not_enrolled`, `not_open`), so a payload for someone else's card changes nothing.
 */
export function registerHandlers(app: ActionRouter, deps: SchedulerDeps): void {
  const clock: Clock = deps.clock;
  const logClick = (a: ClickArgs) => console.log(`[${clock.now().toISOString()}] click user=${a.body.user.id} action_id=${a.action.action_id}`);

  async function reject(a: ClickArgs, reason: RejectReason) {
    console.log(`refused user=${a.body.user.id} reason=${reason}`);
    await replace(a.respond, buildRejectionMessage(reason));
  }

  /** Stores the answer, shows the outcome, then sends the next card. `rating` is set on the second click only. */
  async function settle(a: ClickArgs, userId: string, flashcardId: string, chosenOption: number | null, rating?: Rating) {
    const result = await submitAnswer(deps, { userId, flashcardId, chosenOption, ...(rating && { rating }), ...(a.body.message?.ts && { messageTs: a.body.message.ts }) });
    if (result.status === 'duplicate') return; // the click that won already replaced the message
    if (result.status === 'rejected') return reject(a, result.reason);
    const card = (await getFlashcard(deps.db, flashcardId))!;
    await replace(a.respond, result.review.isCorrect && rating ? buildRatedMessage(rating) : buildWrongMessage(card, result.materialUrl));
    try {
      await afterAnswer(deps, userId, card.courseId, result);
    } catch (err) {
      console.error(`next card after the answer of user ${userId} failed`, errName(err)); // the card stays claimed; the tick re-posts it
    }
  }

  const guarded = (kind: string, run: (a: ClickArgs, userId: string) => Promise<void>) => async (a: ClickArgs) => {
    await a.ack();
    logClick(a);
    try {
      const user = await findUserBySlackId(deps.db, a.body.user.id);
      if (!user) return await reject(a, 'not_enrolled');
      await run(a, user.id);
    } catch (err) {
      if (err instanceof InvalidOptionError) return console.warn(`ignored ${kind} click of user ${a.body.user.id}: option out of range`);
      console.error(`${kind} click of user ${a.body.user.id} failed`, errName(err));
      try {
        await a.respond({ text: ERROR_TEXT, replace_original: false, response_type: 'ephemeral' });
      } catch {
        // nothing more to do: the student can click again
      }
    }
  };

  app.action(/^answer_/, async (a) => {
    // ack() must be first: Slack waits 3 seconds. `guarded` acks before anything else, but parsing is cheap and stays after it.
    await guarded('answer', async (click, userId) => {
      const v = parseValue(answerValue, rawValue(click.action));
      if (!v) return console.warn(`ignored malformed answer value from user ${click.body.user.id}`);
      const messageTs = click.body.message?.ts;
      const first = await previewAnswer(deps, { userId, flashcardId: v.c, chosenOption: v.o, ...(messageTs && { messageTs }) });
      if (first.status === 'rejected') return reject(click, first.reason);
      // A right answer waits for its rating and stores nothing (H5); wrong and "Don't know" are final at once (H7).
      if (first.isCorrect) return void (await replace(click.respond, buildRatingMessage({ id: v.c }, v.o!)));
      await settle(click, userId, v.c, v.o);
    })(a);
  });

  app.action(/^rate_/, async (a) => {
    await guarded('rating', async (click, userId) => {
      const v = parseValue(rateValue, rawValue(click.action));
      if (!v) return console.warn(`ignored malformed rating value from user ${click.body.user.id}`);
      // isCorrect is recomputed on the server from `o` inside submitAnswer; a rating for a wrong option is ignored (decision 0004).
      await settle(click, userId, v.c, v.o, v.r);
    })(a);
  });
}

