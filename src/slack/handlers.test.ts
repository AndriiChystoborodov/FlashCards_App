import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { draftCourse, harness } from '../api/harness.js';
import { getCardState } from '../db/cardStates.js';
import { reviews } from '../db/schema.js';
import { db, pool } from '../db/testDb.js';
import { findUserByEmail } from '../db/users.js';
import { REJECT_TEXT, ERROR_TEXT } from './card.js';
import { registerHandlers, type ClickArgs } from './handlers.js';

afterAll(() => pool.end());

type Handler = (a: ClickArgs) => Promise<void>;
type Sent = { text: string; blocks?: unknown[]; replace_original: boolean; response_type?: string };

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** A started course (4 cards, 2 assessment, correct option 0) with student Ann enrolled and holding her first card. */
async function world(deps?: (d: Awaited<ReturnType<typeof harness>>['deps']) => Parameters<typeof registerHandlers>[1]) {
  const h = await harness();
  const tom = await h.teacher();
  const { courseId, cardIds } = await draftCourse(h, tom, 4, 2);
  const routes: { pattern: RegExp; handler: Handler }[] = [];
  registerHandlers({ action: (pattern, handler) => void routes.push({ pattern, handler }) }, deps ? deps(h.deps) : h.deps);

  const person = async (who: string) => {
    const email = h.matched(who);
    await h.api.call(tom, 'POST', `/courses/${courseId}/students`, { students: [{ email, name: who }] });
    return { email, slackId: h.slack.directory.get(email)!.slackId, userId: (await findUserByEmail(db, email))!.id };
  };
  const ann = await person('ann');
  await h.api.call(tom, 'POST', `/courses/${courseId}/start`);

  /** The newest card message the fake posted to this Slack user: ts, channel and what its buttons carry. */
  const latest = (slackId: string) => {
    const p = h.slack.posted.filter((m) => m.to === slackId || m.channel === `D-${slackId}`).filter((m) => JSON.stringify(m.message.blocks).includes('answer_1')).at(-1)!;
    const values = p.message.blocks.flatMap((b) => (b.type === 'actions' ? b.elements : [])).map((e) => ('value' in e ? String(e.value) : ''));
    return { ts: p.ts, cardId: (JSON.parse(values[0]!) as { c: string }).c, values, message: p.message };
  };

  const calls: string[] = [];
  const respond = vi.fn(async (_m: Sent) => void calls.push('respond'));
  const click = async (slackId: string, actionId: string, value: unknown, ts?: string, blocks?: unknown[]) => {
    const ack = vi.fn(async () => void calls.push('ack'));
    const route = routes.find((r) => r.pattern.test(actionId));
    if (!route) throw new Error(`no route for ${actionId}`);
    const action = (value === undefined ? { action_id: actionId } : { action_id: actionId, value }) as ClickArgs['action'];
    await route.handler({ ack, action, body: { user: { id: slackId }, ...((ts || blocks) && { message: { ...(ts && { ts }), ...(blocks && { blocks }) } }) }, respond });
    return ack;
  };
  const answer = (slackId: string, option: number | null, cardId: string, ts?: string, blocks?: unknown[]) =>
    click(slackId, option === null ? 'answer_dont_know' : `answer_${option + 1}`, JSON.stringify({ c: cardId, o: option }), ts, blocks);
  const rate = (slackId: string, option: number, r: string, cardId: string, ts?: string, blocks?: unknown[]) => click(slackId, `rate_${r}`, JSON.stringify({ c: cardId, o: option, r }), ts, blocks);
  const reviewsOf = (userId: string) => db.select().from(reviews).where(eq(reviews.userId, userId));
  const last = () => respond.mock.calls.at(-1)![0];
  return { h, tom, courseId, cardIds, ann, person, latest, click, answer, rate, reviewsOf, respond, calls, last, routes };
}

describe('Slack handlers on the real services (FakeSlack)', () => {
  it('H8: answer_1..answer_9, answer_dont_know and rate_* are all routed', async () => {
    const w = await world();
    for (const id of ['answer_1', 'answer_2', 'answer_3', 'answer_9', 'answer_dont_know']) expect(w.routes.filter((r) => r.pattern.test(id))).toHaveLength(1);
    for (const id of ['rate_hard', 'rate_medium', 'rate_easy']) expect(w.routes.filter((r) => r.pattern.test(id))).toHaveLength(1);
    expect(w.routes.some((r) => r.pattern.test('other_1'))).toBe(false);
  });

  it('H1: nothing but ack() happens until the ack has resolved (checked with an ack held open)', async () => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    let release!: () => void;
    const ack = () => new Promise<void>((r) => (release = r));
    const route = w.routes.find((r) => r.pattern.test('answer_2'))!;
    const done = route.handler({ ack, action: { action_id: 'answer_2', value: JSON.stringify({ c: c.cardId, o: 1 }) } as ClickArgs['action'], body: { user: { id: w.ann.slackId }, message: { ts: c.ts } }, respond: w.respond });
    await new Promise((r) => setTimeout(r, 100));
    expect(w.respond).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled(); // not even the click line
    release();
    await done;
    expect(w.respond).toHaveBeenCalledTimes(1);
  });

  it('H2: no message the system posts carries the correct option or the word "correct"', async () => {
    const w = await world();
    for (const m of w.h.slack.posted) expect(JSON.stringify(m.message)).not.toMatch(/correct/i);
    const c = w.latest(w.ann.slackId);
    await w.answer(w.ann.slackId, 0, c.cardId, c.ts);
    expect(JSON.stringify(w.last())).not.toMatch(/correct/i); // the rating prompt carries the chosen option and card id only
    expect(c.values.map((v) => Object.keys(JSON.parse(v)).sort())).toEqual(Array(4).fill(['c', 'o']));
  });

  it.each([
    ['not a string', 42],
    ['no value', undefined],
    ['invalid JSON', '{nope'],
    ['wrong shape', '{"x":1}'],
    ['negative option', '{"c":"a","o":-1}'],
    ['fractional option', '{"c":"a","o":1.5}'],
    ['option as a string', '{"c":"a","o":"1"}'],
  ])('H3: a malformed answer value (%s) does nothing', async (_n, value) => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    const ack = await w.click(w.ann.slackId, 'answer_1', value, c.ts);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    expect(w.respond).not.toHaveBeenCalled();
    expect(await w.reviewsOf(w.ann.userId)).toHaveLength(0);
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['unknown rating', '{"c":"a","o":0,"r":"awful"}'],
    ['rating missing', '{"c":"a","o":0}'],
    ['negative option', '{"c":"a","o":-1,"r":"easy"}'],
    ['null option', '{"c":"a","o":null,"r":"easy"}'],
  ])('H3: a malformed rating value (%s) does nothing', async (_n, value) => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    const ack = await w.click(w.ann.slackId, 'rate_easy', value, c.ts);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    expect(w.respond).not.toHaveBeenCalled();
    expect(await w.reviewsOf(w.ann.userId)).toHaveLength(0);
  });

  it('H5: a right first click shows Hard / Medium / Easy and changes no state', async () => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    const before = await getCardState(db, w.ann.userId, c.cardId);
    await w.answer(w.ann.slackId, 0, c.cardId, c.ts);
    expect(w.last().text).toBe('Right. How hard was it?');
    expect(w.last().replace_original).toBe(true);
    expect(JSON.stringify(w.last())).toContain('rate_hard');
    expect(await w.reviewsOf(w.ann.userId)).toHaveLength(0);
    expect(await getCardState(db, w.ann.userId, c.cardId)).toEqual(before);
    expect(before!.sentAt).not.toBeNull();
  });

  it('H6 and H10: the rating click stores one review with the rating, shows no buttons and sends the next card', async () => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    const postsBefore = w.h.slack.posted.length;
    await w.rate(w.ann.slackId, 0, 'medium', c.cardId, c.ts);
    expect(w.last()).toMatchObject({ text: 'Thanks. You rated it Medium.', replace_original: true });
    expect(JSON.stringify(w.last().blocks)).not.toContain('actions');
    const rows = await w.reviewsOf(w.ann.userId);
    expect(rows.map((r) => [r.isCorrect, r.rating, r.chosenOption])).toEqual([[true, 'medium', 0]]);
    expect(w.h.slack.posted.length).toBe(postsBefore + 1);
    expect(w.latest(w.ann.slackId).cardId).not.toBe(c.cardId);
  });

  it('H10: isCorrect is recomputed on the server: a rating sent for a wrong option is a wrong answer (Again)', async () => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    await w.rate(w.ann.slackId, 1, 'easy', c.cardId, c.ts);
    const rows = await w.reviewsOf(w.ann.userId);
    expect(rows.map((r) => [r.isCorrect, r.rating])).toEqual([[false, null]]);
    expect(w.last().text).toMatch(/^Not quite\. The right answer is 1: right\./);
  });

  it.each([
    ['a wrong option', 1],
    ['Don\'t know', null],
  ])('H7: %s shows the right answer and the material, stores one review and sends the next card', async (_n, option) => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    await w.answer(w.ann.slackId, option, c.cardId, c.ts);
    expect(w.last().text).toBe('Not quite. The right answer is 1: right.\nMaterial: https://x.test/m');
    expect(JSON.stringify(w.last().blocks)).not.toContain('actions');
    const rows = await w.reviewsOf(w.ann.userId);
    expect(rows.map((r) => [r.isCorrect, r.rating, r.chosenOption])).toEqual([[false, null, option]]);
    expect(w.latest(w.ann.slackId).cardId).not.toBe(c.cardId);
  });

  it('H4: a click by a user who does not own the card is refused and changes nothing', async () => {
    const w = await world();
    const bea = await w.person('bea'); // enrolled in the same course, holds her own card
    const a = w.latest(w.ann.slackId);
    const b = w.latest(bea.slackId);
    expect(b.cardId).toBe(a.cardId); // the same flashcard in this small course, but a different delivery
    // Bea clicks Ann's message (her ts): the delivery check refuses it, and Ann's card is untouched.
    await w.rate(bea.slackId, 0, 'easy', a.cardId, a.ts);
    expect(w.last().text).toBe(REJECT_TEXT.sent_again);
    // Bea clicks with no message ts at all: she answers her own card, never Ann's.
    await w.answer(bea.slackId, null, a.cardId);
    expect(await w.reviewsOf(w.ann.userId)).toHaveLength(0);
    expect((await getCardState(db, w.ann.userId, a.cardId))!.sentAt).not.toBeNull();
    expect((await w.reviewsOf(bea.userId)).length).toBe(1);
  });

  it('a student with no open card for that flashcard gets "already answered", and an unknown Slack user "not enrolled"; nothing is stored', async () => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    const otherEmail = w.h.matched('cy'); // exists in Slack, never enrolled anywhere
    const cyId = w.h.slack.directory.get(otherEmail)!.slackId;
    await w.answer(cyId, 0, c.cardId, c.ts);
    expect(w.last().text).toBe(REJECT_TEXT.not_enrolled);
    await w.answer('U-nobody', 0, c.cardId, c.ts);
    expect(w.last().text).toBe(REJECT_TEXT.not_enrolled);
    expect(await w.reviewsOf(w.ann.userId)).toHaveLength(0);
    // another enrolled user with no card state for a flashcard of a card that does not exist
    await w.answer(w.ann.slackId, 0, crypto.randomUUID(), c.ts);
    expect(w.last().text).toBe(REJECT_TEXT.not_open);
  });

  it('the second click on an answered card is "already answered" and stores nothing more', async () => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    await w.answer(w.ann.slackId, null, c.cardId, c.ts);
    await w.answer(w.ann.slackId, null, c.cardId, c.ts);
    expect(w.last().text).toBe(REJECT_TEXT.not_open);
    expect(await w.reviewsOf(w.ann.userId)).toHaveLength(1);
  });

  it('a click on an older message than the stored one is "sent again" and changes nothing', async () => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    await w.answer(w.ann.slackId, null, c.cardId, '999.000999');
    expect(w.last().text).toBe(REJECT_TEXT.sent_again);
    expect(await w.reviewsOf(w.ann.userId)).toHaveLength(0);
    expect((await getCardState(db, w.ann.userId, c.cardId))!.sentAt).not.toBeNull();
  });

  it('a removed student gets "no longer enrolled"; a stopped course "the course is over"; no review is stored', async () => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    await w.h.api.call(w.tom, 'DELETE', `/courses/${w.courseId}/students/${w.ann.userId}`);
    await w.answer(w.ann.slackId, null, c.cardId, c.ts);
    expect(w.last().text).toBe(REJECT_TEXT.removed);
    const w2 = await world();
    const c2 = w2.latest(w2.ann.slackId);
    await w2.h.api.call(w2.tom, 'POST', `/courses/${w2.courseId}/stop`);
    await w2.rate(w2.ann.slackId, 0, 'easy', c2.cardId, c2.ts);
    expect(w2.last().text).toBe(REJECT_TEXT.course_over);
    expect(await w2.reviewsOf(w2.ann.userId)).toHaveLength(0);
  });

  it('two clicks at once store one review', async () => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    await Promise.all([w.rate(w.ann.slackId, 0, 'easy', c.cardId, c.ts), w.rate(w.ann.slackId, 0, 'easy', c.cardId, c.ts)]);
    expect(await w.reviewsOf(w.ann.userId)).toHaveLength(1);
    expect(w.respond.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('an option outside the card is ignored with a warning and nothing is shown or stored', async () => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    await w.answer(w.ann.slackId, 7, c.cardId, c.ts);
    expect(warn).toHaveBeenCalled();
    expect(w.respond).not.toHaveBeenCalled();
    expect(await w.reviewsOf(w.ann.userId)).toHaveLength(0);
  });

  it('a Slack outage while sending the next card is logged; the answer is stored and its message replaced', async () => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    w.h.slack.failNextPost = new Error('boom');
    await w.answer(w.ann.slackId, null, c.cardId, c.ts);
    expect(w.last().text).toMatch(/^Not quite/);
    expect(await w.reviewsOf(w.ann.userId)).toHaveLength(1);
    expect(error).toHaveBeenCalled();
    // the claimed next card stays open without a message_ts, which the tick recovers (decision 0027)
  });

  it('an unexpected error shows the ephemeral error text and logs no secret and no payload', async () => {
    const SECRET = 'xoxb-SECRET-TOKEN';
    const w = await world((d) => ({ ...d, db: new Proxy(d.db, { get: () => { throw new Error(`password=${SECRET}`); } }) }));
    const c = w.latest(w.ann.slackId);
    await w.answer(w.ann.slackId, 0, c.cardId, c.ts);
    expect(w.last()).toEqual({ text: ERROR_TEXT, replace_original: false, response_type: 'ephemeral' });
    const logged = JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(c.cardId);
    expect(logged).not.toContain('"o"');
  });

  it('the click log has the clock time, the user and the action id, and no button value', async () => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    await w.answer(w.ann.slackId, 0, c.cardId, c.ts);
    const line = log.mock.calls.map((x: unknown[]) => String(x[0])).find((l: string) => l.includes('click'))!;
    expect(line).toBe(`[2026-01-05T09:00:00.000Z] click user=${w.ann.slackId} action_id=answer_1`);
  });

  it('the first click of a right answer is refused for a removed student without revealing the rating prompt', async () => {
    const w = await world();
    const c = w.latest(w.ann.slackId);
    await w.h.api.call(w.tom, 'DELETE', `/courses/${w.courseId}/students/${w.ann.userId}`);
    await w.answer(w.ann.slackId, 0, c.cardId, c.ts);
    expect(JSON.stringify(w.last())).not.toContain('rate_');
  });

  describe('image cards: the image is kept or dropped on replace (decision 0034)', () => {
    // What Slack puts in body.message.blocks of a clicked image card: id AND url in slack_file (only the id may be sent back).
    const imageBlocks = (extra: object = {}) => [{ type: 'image', slack_file: { id: 'F123', url: 'https://files.slack.test/secret-url' }, alt_text: 'Q1 on the image', ...extra }, { type: 'section' }, { type: 'actions' }];
    const kinds = (m: Sent) => (m.blocks as { type: string }[]).map((b) => b.type);

    it('the rating prompt and the right-answer outcome keep the image, sending only the file id', async () => {
      const w = await world();
      const c = w.latest(w.ann.slackId);
      await w.answer(w.ann.slackId, 0, c.cardId, c.ts, imageBlocks());
      expect(kinds(w.last())).toEqual(['image', 'section', 'actions']);
      expect(w.last().blocks![0]).toEqual({ type: 'image', slack_file: { id: 'F123' }, alt_text: 'Q1 on the image' });
      expect(JSON.stringify(w.last())).not.toContain('secret-url');
      await w.rate(w.ann.slackId, 0, 'easy', c.cardId, c.ts, imageBlocks());
      expect(kinds(w.last())).toEqual(['image', 'section']);
      expect(w.last().text).toBe('Thanks. You rated it Easy.');
    });

    it('the wrong-answer outcome keeps the image and shows the right answer', async () => {
      const w = await world();
      const c = w.latest(w.ann.slackId);
      await w.answer(w.ann.slackId, 1, c.cardId, c.ts, imageBlocks());
      expect(kinds(w.last())).toEqual(['image', 'section']);
      expect(w.last().text).toMatch(/^Not quite/);
    });

    it('a text card (no image block) is replaced exactly as before', async () => {
      const w = await world();
      const c = w.latest(w.ann.slackId);
      await w.answer(w.ann.slackId, 1, c.cardId, c.ts, [{ type: 'section' }, { type: 'actions' }]);
      expect(kinds(w.last())).toEqual(['section']);
    });

    it('a url-only slack_file is sent back as the url; an unreadable one is dropped with a logged code', async () => {
      const w = await world();
      const c = w.latest(w.ann.slackId);
      await w.answer(w.ann.slackId, 0, c.cardId, c.ts, [{ type: 'image', slack_file: { url: 'https://files.slack.test/x' }, alt_text: 'a' }]);
      expect(w.last().blocks![0]).toEqual({ type: 'image', slack_file: { url: 'https://files.slack.test/x' }, alt_text: 'a' });
      await w.answer(w.ann.slackId, 0, c.cardId, c.ts, [{ type: 'image', alt_text: 'a' }]);
      expect(kinds(w.last())).toEqual(['section', 'actions']);
      expect(warn.mock.calls.flat().join(' ')).toContain('image_ref_unreadable');
    });

    it('a refusal (sent again, removed, over, already answered) replaces with text only and drops the image', async () => {
      const w = await world();
      const c = w.latest(w.ann.slackId);
      await w.answer(w.ann.slackId, 0, '00000000-0000-4000-8000-000000000000', c.ts, imageBlocks()); // not the open card
      expect(kinds(w.last())).toEqual(['section']);
      await w.answer(w.ann.slackId, 0, c.cardId, '0.0', imageBlocks()); // an older message: sent again
      expect(w.last().text).toBe(REJECT_TEXT.sent_again);
      expect(kinds(w.last())).toEqual(['section']);
    });
  });
});
