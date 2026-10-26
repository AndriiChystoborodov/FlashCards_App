import { z } from 'zod';
import { systemClock, type Clock } from '../clock.js';
import { answerValue, parseValue, rateValue, rawValue, type ClickArgs, type ActionRouter } from './handlers.js';
import {
  SPIKE_CARD,
  buildAlreadyAnsweredMessage,
  buildRatedMessage,
  buildRatingMessage,
  buildWrongMessage,
  type CardMessage,
  type SpikeCard,
} from './card.js';

export interface HandlerDeps {
  cards?: Record<string, SpikeCard>;
  clock?: Clock;
}

export function registerSpikeHandlers(app: ActionRouter, deps: HandlerDeps = {}): void {
  const cards = deps.cards ?? { [SPIKE_CARD.id]: SPIKE_CARD };
  const clock = deps.clock ?? systemClock;
  // Spike only: in memory, lost on restart. Real state arrives with the database (Task 4+).
  const finished = new Set<string>();
  const replace = (respond: ClickArgs['respond'], m: CardMessage) => respond({ ...m, replace_original: true });

  // The timestamp is the receiving process's clock, so a retried delivery shows up as a second line.
  const logClick = (a: ClickArgs) =>
    console.log(`[${clock.now().toISOString()}] click user=${a.body.user.id} action_id=${a.action.action_id} value=${String(rawValue(a.action))}`);

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
