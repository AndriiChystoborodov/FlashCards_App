import { z } from 'zod';
import {
  SPIKE_CARD,
  buildAlreadyAnsweredMessage,
  buildRatedMessage,
  buildRatingMessage,
  buildWrongMessage,
  type CardMessage,
  type SpikeCard,
} from './card.js';

const answerValue = z.object({ c: z.string(), o: z.number().int().min(0).nullable() });
const rateValue = z.object({ c: z.string(), o: z.number().int().min(0), r: z.enum(['hard', 'medium', 'easy']) });

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

/** The part of Bolt's action args the spike uses; Bolt's own args are assignable to it. */
export interface ClickArgs {
  ack: () => Promise<unknown>;
  action: { action_id: string };
  body: { user: { id: string } };
  respond: (message: CardMessage & { replace_original: true }) => Promise<unknown>;
}

export interface ActionRouter {
  action(pattern: RegExp, handler: (args: ClickArgs) => Promise<void>): unknown;
}

export interface HandlerDeps {
  cards?: Record<string, SpikeCard>;
  now?: () => Date;
}

const rawValue = (action: object): unknown => ('value' in action ? action.value : undefined);

export function registerHandlers(app: ActionRouter, deps: HandlerDeps = {}): void {
  const cards = deps.cards ?? { [SPIKE_CARD.id]: SPIKE_CARD };
  const now = deps.now ?? (() => new Date());
  // Spike only: in memory, lost on restart. Real state arrives with the database (Task 4+).
  const finished = new Set<string>();
  const replace = (respond: ClickArgs['respond'], m: CardMessage) => respond({ ...m, replace_original: true });

  // The timestamp is the receiving process's clock, so a retried delivery shows up as a second line.
  const logClick = (a: ClickArgs) =>
    console.log(`[${now().toISOString()}] click user=${a.body.user.id} action_id=${a.action.action_id} value=${String(rawValue(a.action))}`);

  app.action(/^answer_/, async (a) => {
    await a.ack();
    logClick(a);
    const v = parseValue(answerValue, rawValue(a.action));
    if (!v) return console.warn({ user: a.body.user.id, action: a.action.action_id }, 'ignored malformed answer value');
    const card = cards[v.c];
    if (!card) return console.warn({ user: a.body.user.id, card: v.c }, 'ignored unknown card id');
    const key = `${a.body.user.id}:${card.id}`;
    if (finished.has(key)) return void (await replace(a.respond, buildAlreadyAnsweredMessage()));
    if (v.o === card.correctOption) return void (await replace(a.respond, buildRatingMessage(card, v.o)));
    finished.add(key);
    await replace(a.respond, buildWrongMessage(card));
  });

  app.action(/^rate_/, async (a) => {
    await a.ack();
    logClick(a);
    const v = parseValue(rateValue, rawValue(a.action));
    if (!v) return console.warn({ user: a.body.user.id, action: a.action.action_id }, 'ignored malformed rating value');
    const card = cards[v.c];
    if (!card) return console.warn({ user: a.body.user.id, card: v.c }, 'ignored unknown card id');
    const key = `${a.body.user.id}:${card.id}`;
    if (finished.has(key)) return void (await replace(a.respond, buildAlreadyAnsweredMessage()));
    // isCorrect is recomputed on the server from `o`; a rating for a wrong option is ignored (decision 0004).
    if (v.o !== card.correctOption) return console.warn({ user: a.body.user.id, card: v.c }, 'ignored rating for a wrong option');
    finished.add(key);
    console.log(`rating user=${a.body.user.id} card=${v.c} option=${v.o} rating=${v.r}`);
    await replace(a.respond, buildRatedMessage(v.r));
  });
}
