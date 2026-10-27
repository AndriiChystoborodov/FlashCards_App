import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createControlledClock } from '../clock.js';
import { newCardState, type CardState } from '../domain/calculator.js';
import { getCardState, upsertCardState } from '../db/cardStates.js';
import { getOpenCard } from '../db/selection.js';
import { cardStates, courses, enrollments, flashcards, reviews, users } from '../db/schema.js';
import { db, pool } from '../db/testDb.js';
import { FakeSlack } from '../slack/fake.js';
import { CardImageError } from '../slack/port.js';
import * as renderModule from '../render/card.js';
import { submitAnswer } from './answer.js';
import { afterAnswer, finishCourse, finishEndedCourses, next, resendStaleClaim, sendFirstCards, sendNext, TEXT, type SchedulerDeps } from './scheduler.js';

afterAll(() => pool.end());

const Z = 'Europe/Zurich';
const MON = new Date('2026-01-05T09:00:00Z'); // Monday 10:00 Zurich
const ENDS = new Date('2026-01-16T22:59:00Z'); // Friday 16 January 23:59 Zurich

interface World {
  studentId: string;
  courseId: string;
  assessmentIds: string[];
  normalIds: string[];
  slack: FakeSlack;
  clock: ReturnType<typeof createControlledClock>;
  deps: SchedulerDeps;
}

async function world(o: { tz?: string | null; endsAt?: Date; assessment?: number; normal?: number; start?: Date; slackId?: string | null; courseStatus?: string } = {}): Promise<World> {
  const tag = crypto.randomUUID();
  const [teacher] = await db.insert(users).values({ fullName: 'T', email: `t-${tag}@x.test`, role: 'teacher' }).returning();
  const [student] = await db
    .insert(users)
    .values({ fullName: 'S', email: `s-${tag}@x.test`, role: 'student', tz: o.tz === undefined ? Z : o.tz, slackId: o.slackId === undefined ? `U${tag}` : o.slackId })
    .returning();
  const [course] = await db
    .insert(courses)
    .values({ teacherId: teacher!.id, title: 'C', materialUrl: 'https://course.test', status: o.courseStatus ?? 'active', startsAt: MON, endsAt: o.endsAt ?? ENDS })
    .returning();
  const make = async (n: number, isAssessment: boolean, from: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [c] = await db.insert(flashcards).values({ courseId: course!.id, question: `Q${from + i}`, options: ['a', 'b', 'c'], correctOption: 0, isAssessment, position: from + i }).returning();
      ids.push(c!.id);
    }
    return ids;
  };
  const assessmentIds = await make(o.assessment ?? 0, true, 1);
  const normalIds = await make(o.normal ?? 1, false, 100);
  await db.insert(enrollments).values({ courseId: course!.id, userId: student!.id, status: 'active', enrolledAt: MON });
  const clock = createControlledClock(o.start ?? MON);
  const slack = new FakeSlack();
  return { studentId: student!.id, courseId: course!.id, assessmentIds, normalIds, slack, clock, deps: { db, clock, tenantTimezone: 'UTC', slack } };
}

/** A student with their own enrollment in the same course (for course-level tests). */
async function addStudent(w: World, status = 'active', removedAt: Date | null = null, slackId: string | null = `U${crypto.randomUUID()}`) {
  const tag = crypto.randomUUID();
  const [s] = await db.insert(users).values({ fullName: 'S2', email: `s2-${tag}@x.test`, role: 'student', tz: Z, slackId }).returning();
  await db.insert(enrollments).values({ courseId: w.courseId, userId: s!.id, status, enrolledAt: MON, removedAt });
  return s!.id;
}

/** The student answers the open card (right option 0) and the scheduler does what follows the answer. */
async function reply(w: World, option: number | null, rating?: 'hard' | 'medium' | 'easy') {
  const open = await getOpenCard(db, w.studentId, w.courseId);
  if (!open) throw new Error('no open card');
  const result = await submitAnswer(w.deps, {
    userId: w.studentId, flashcardId: open.flashcardId, chosenOption: option, ...(rating && { rating }), ...(open.messageTs && { messageTs: open.messageTs }),
  });
  const sent = await afterAnswer(w.deps, w.studentId, w.courseId, result);
  return { result, sent, id: open.flashcardId };
}

const seed = (w: World, flashcardId: string, state: CardState, over: { sentAt?: Date | null; userId?: string } = {}) =>
  upsertCardState(db, {
    userId: over.userId ?? w.studentId, flashcardId, state, introducedAt: new Date('2026-01-01T00:00:00Z'), sentAt: over.sentAt ?? null,
    remindedAt: null, reminderCount: 0, messageChannel: null, messageTs: null,
  });

/** A reviewed card: due as given, last reviewed as given. */
const reviewed = (lastReview: Date, due: Date, extra: Partial<CardState> = {}): CardState => ({
  ...newCardState(lastReview), state: 2, reps: 2, stability: 3, difficulty: 5, scheduled_days: 2, last_review: lastReview, due, ...extra,
});

const openCount = async (w: World) =>
  (await db.select().from(cardStates).where(and(eq(cardStates.userId, w.studentId), isNotNull(cardStates.sentAt)))).length;
const enrollmentOf = async (userId: string) => (await db.select().from(enrollments).where(eq(enrollments.userId, userId)))[0]!;
const textOf = (m: { message: { text: string } }) => m.message.text;

describe('selection: next() and sendNext()', () => {
  it('S1: assessment cards come first, one after another, ignoring the new-card quota', async () => {
    const w = await world({ assessment: 3, normal: 7 });
    expect((await next(w.deps, w.studentId, w.courseId))?.kind).toBe('assessment');
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const sent = i === 0 ? await sendNext(w.deps, w.studentId, w.courseId) : (await reply(w, 0, 'easy')).sent;
      expect(sent.status).toBe('sent');
      if (sent.status === 'sent') order.push(sent.flashcardId);
    }
    expect(order).toEqual(w.assessmentIds);
  });

  it('S53: assessment cards sent today do not use up the quota; 7 cards over 12 days give one new card', async () => {
    const w = await world({ assessment: 3, normal: 7 });
    await sendNext(w.deps, w.studentId, w.courseId);
    await reply(w, 0, 'easy');
    await reply(w, 0, 'medium');
    const { sent } = await reply(w, null); // last assessment card: 1 of 3 passed, not exempt
    expect(sent).toMatchObject({ status: 'sent', kind: 'new', flashcardId: w.normalIds[0] });
    expect(await next(w.deps, w.studentId, w.courseId)).toBeNull(); // open card
    const { sent: after } = await reply(w, 0, 'medium'); // card-1 answered
    expect(after).toEqual({ status: 'none' }); // quota 1 used: introducedToday 1, remaining 6, 12 days
  });

  it('S3 (rest): an exempt student gets the message and no card, now or later', async () => {
    const w = await world({ assessment: 2, normal: 3 });
    await sendNext(w.deps, w.studentId, w.courseId);
    await reply(w, 0, 'easy');
    const { sent } = await reply(w, 0, 'easy');
    expect(sent).toEqual({ status: 'none' });
    expect((await enrollmentOf(w.studentId)).status).toBe('exempt');
    expect(textOf(w.slack.posted.at(-1)!)).toBe(TEXT.exempt);
    w.clock.advanceDays(3);
    expect(await sendNext(w.deps, w.studentId, w.courseId)).toEqual({ status: 'none' });
    expect(await next(w.deps, w.studentId, w.courseId)).toBeNull();
  });

  it('S4 (rest): passed assessment cards are not selected again, the others come back through FSRS', async () => {
    const w = await world({ assessment: 2, normal: 0 });
    await sendNext(w.deps, w.studentId, w.courseId);
    await reply(w, 0, 'easy'); // passed, learned
    await reply(w, null); // not passed
    w.clock.advanceDays(1);
    const n = await next(w.deps, w.studentId, w.courseId);
    expect(n).toMatchObject({ kind: 'due', card: { id: w.assessmentIds[1] } });
  });

  it('S5: a due card comes before a new card', async () => {
    const w = await world({ normal: 3 });
    await seed(w, w.normalIds[2]!, reviewed(new Date('2026-01-04T09:00:00Z'), new Date('2026-01-05T10:00:00Z')));
    await db.update(enrollments).set({ assessmentDoneAt: MON }).where(eq(enrollments.userId, w.studentId));
    expect(await next(w.deps, w.studentId, w.courseId)).toMatchObject({ kind: 'due', card: { id: w.normalIds[2] } });
  });

  it('due cards are ordered by due, ties by position', async () => {
    const w = await world({ normal: 3 });
    await db.update(enrollments).set({ assessmentDoneAt: MON }).where(eq(enrollments.userId, w.studentId));
    await seed(w, w.normalIds[0]!, reviewed(new Date('2026-01-04T09:00:00Z'), new Date('2026-01-05T12:00:00Z')));
    await seed(w, w.normalIds[1]!, reviewed(new Date('2026-01-04T09:00:00Z'), new Date('2026-01-05T11:00:00Z')));
    expect((await next(w.deps, w.studentId, w.courseId))?.card.id).toBe(w.normalIds[1]);
  });

  it('S6: when introducedToday reaches the quota there is no more new card today', async () => {
    const w = await world({ normal: 7 });
    const first = await sendNext(w.deps, w.studentId, w.courseId);
    expect(first).toMatchObject({ status: 'sent', kind: 'new' });
    await reply(w, 0, 'medium');
    expect(await next(w.deps, w.studentId, w.courseId)).toBeNull();
  });

  it('S7: the day boundary is the student\'s local midnight, not UTC', async () => {
    const w = await world({ normal: 7, start: new Date('2026-01-05T22:30:00Z') }); // 23:30 Zurich
    await sendNext(w.deps, w.studentId, w.courseId);
    await reply(w, 0, 'medium');
    expect(await next(w.deps, w.studentId, w.courseId)).toBeNull();
    w.clock.set(new Date('2026-01-05T23:30:00Z')); // 00:30 on the 6th in Zurich, still the 5th in UTC
    expect(await next(w.deps, w.studentId, w.courseId)).toMatchObject({ kind: 'new' });
  });

  it('S8: a learned card is never selected', async () => {
    const w = await world({ normal: 1 });
    await db.update(enrollments).set({ assessmentDoneAt: MON }).where(eq(enrollments.userId, w.studentId));
    await seed(w, w.normalIds[0]!, reviewed(new Date('2026-01-01T09:00:00Z'), new Date('2026-01-02T09:00:00Z'), { learnedAt: new Date('2026-01-01T09:00:00Z'), correctStreak: 2 }));
    expect(await next(w.deps, w.studentId, w.courseId)).toBeNull();
  });

  it('S9: with one card open nothing else is sent', async () => {
    const w = await world({ normal: 5 });
    expect((await sendNext(w.deps, w.studentId, w.courseId)).status).toBe('sent');
    expect(await sendNext(w.deps, w.studentId, w.courseId)).toEqual({ status: 'none' });
    w.clock.advanceDays(2);
    expect(await sendNext(w.deps, w.studentId, w.courseId)).toEqual({ status: 'none' });
    expect(w.slack.posted).toHaveLength(1);
    expect(await openCount(w)).toBe(1);
  });

  it('S10 (rest): the answer closes the card and the next card is posted at once, and the message is recorded', async () => {
    const w = await world({ assessment: 2, normal: 1 });
    const first = await sendNext(w.deps, w.studentId, w.courseId);
    expect(first.status === 'sent' && first.ts).toBe(w.slack.posted[0]!.ts);
    const rec = await getCardState(db, w.studentId, w.assessmentIds[0]!);
    expect(rec).toMatchObject({ messageChannel: w.slack.posted[0]!.channel, messageTs: w.slack.posted[0]!.ts });
    const { result, sent } = await reply(w, 0, 'medium');
    expect(result.status).toBe('answered');
    expect(sent).toMatchObject({ status: 'sent', flashcardId: w.assessmentIds[1] });
    expect(w.slack.posted).toHaveLength(2);
    expect(await openCount(w)).toBe(1);
  });

  it('S34 (rest): a duplicate answer sends no second card', async () => {
    const w = await world({ assessment: 2, normal: 0 });
    await sendNext(w.deps, w.studentId, w.courseId);
    const open = (await getOpenCard(db, w.studentId, w.courseId))!;
    const input = { userId: w.studentId, flashcardId: open.flashcardId, chosenOption: 0, rating: 'medium' as const };
    const r1 = await submitAnswer(w.deps, input);
    await afterAnswer(w.deps, w.studentId, w.courseId, r1);
    const r2 = await submitAnswer(w.deps, input);
    expect(await afterAnswer(w.deps, w.studentId, w.courseId, r2)).toEqual({ status: 'none' });
    expect(w.slack.posted).toHaveLength(2);
  });

  it('caches the DM channel on the first post and posts to the channel afterwards', async () => {
    const w = await world({ assessment: 2, normal: 0 });
    await sendNext(w.deps, w.studentId, w.courseId);
    await reply(w, 0, 'medium');
    const [u] = await db.select().from(users).where(eq(users.id, w.studentId));
    expect(u!.slackDmChannel).toBe(w.slack.posted[0]!.channel);
    expect(w.slack.posted[0]!.to).toBe(u!.slackId);
    expect(w.slack.posted[1]!.to).toBe(u!.slackDmChannel);
  });

  it('the posted message is the card: question and numbered options, buttons without the answer', async () => {
    const w = await world({ normal: 1 });
    await sendNext(w.deps, w.studentId, w.courseId);
    expect(w.slack.posted[0]!.message.text).toBe('Q: Q100\n1. a\n2. b\n3. c');
  });

  it('S11: concurrent sends for one student open one card and post once (real Postgres)', async () => {
    for (let i = 0; i < 30; i++) {
      const w = await world({ assessment: 3, normal: 7 });
      const results = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => sendNext(w.deps, w.studentId, w.courseId)));
      expect(results.filter((r) => r.status === 'sent')).toHaveLength(1);
      expect(w.slack.posted).toHaveLength(1);
      expect(await openCount(w)).toBe(1);
    }
  });

  it('S11 (different picks): with several due cards, concurrent sends still leave one open card (the enrollment lock)', async () => {
    for (let i = 0; i < 30; i++) {
      const w = await world({ normal: 4 });
      await db.update(enrollments).set({ assessmentDoneAt: MON }).where(eq(enrollments.userId, w.studentId));
      for (const [j, id] of w.normalIds.entries()) await seed(w, id, reviewed(new Date('2026-01-04T09:00:00Z'), new Date(`2026-01-05T0${j + 1}:00:00Z`)));
      const results = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => sendNext(w.deps, w.studentId, w.courseId)));
      expect(results.filter((r) => r.status === 'sent')).toHaveLength(1);
      expect(await openCount(w)).toBe(1);
    }
  });

  it('a student without a Slack match gets nothing and no card is claimed', async () => {
    const w = await world({ normal: 2, slackId: null });
    expect(await sendNext(w.deps, w.studentId, w.courseId)).toEqual({ status: 'none' });
    expect(await openCount(w)).toBe(0);
    expect((await db.select().from(cardStates).where(eq(cardStates.userId, w.studentId)))).toHaveLength(0);
  });

  it('a Slack failure after the claim leaves the card open without a message_ts and the error reaches the caller', async () => {
    const w = await world({ normal: 2 });
    w.slack.failNextPost = new Error('slack down');
    await expect(sendNext(w.deps, w.studentId, w.courseId)).rejects.toThrow('slack down');
    const open = await getOpenCard(db, w.studentId, w.courseId);
    expect(open).toMatchObject({ messageTs: null });
    expect(await sendNext(w.deps, w.studentId, w.courseId)).toEqual({ status: 'none' }); // blocked until 6b-2 re-sends it
  });

  it('S15: no sends when the course is not active or the enrollment is not active', async () => {
    for (const status of ['draft', 'finished']) {
      const w = await world({ normal: 2, courseStatus: status });
      expect(await sendNext(w.deps, w.studentId, w.courseId)).toEqual({ status: 'none' });
    }
    for (const status of ['exempt', 'completed']) {
      const w = await world({ normal: 2 });
      await db.update(enrollments).set({ status }).where(eq(enrollments.userId, w.studentId));
      expect(await sendNext(w.deps, w.studentId, w.courseId)).toEqual({ status: 'none' });
    }
  });

  it('S46: a removed enrollment gets no card even with due cards', async () => {
    const w = await world({ normal: 2 });
    await db.update(enrollments).set({ assessmentDoneAt: MON, removedAt: MON }).where(eq(enrollments.userId, w.studentId));
    await seed(w, w.normalIds[0]!, reviewed(new Date('2026-01-04T09:00:00Z'), new Date('2026-01-05T08:00:00Z')));
    expect(await next(w.deps, w.studentId, w.courseId)).toBeNull();
    expect(await sendNext(w.deps, w.studentId, w.courseId)).toEqual({ status: 'none' });
  });

  it('S42: after a restore, overdue cards and the voided card are selected again', async () => {
    const w = await world({ normal: 3 });
    await db.update(enrollments).set({ assessmentDoneAt: MON }).where(eq(enrollments.userId, w.studentId));
    await seed(w, w.normalIds[0]!, reviewed(new Date('2026-01-01T09:00:00Z'), new Date('2026-01-03T09:00:00Z'))); // overdue
    await seed(w, w.normalIds[1]!, newCardState(new Date('2026-01-04T09:00:00Z'))); // voided: sent, then sent_at cleared on removal
    const order: string[] = [];
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? await sendNext(w.deps, w.studentId, w.courseId) : (await reply(w, 0, 'medium')).sent;
      if (s.status === 'sent') order.push(s.flashcardId);
    }
    expect(order).toEqual([w.normalIds[0], w.normalIds[1]]);
  });

  it('S42: a voided assessment card is selected again after a restore, in the assessment phase', async () => {
    const w = await world({ assessment: 2, normal: 1 });
    await seed(w, w.assessmentIds[0]!, newCardState(new Date('2026-01-04T09:00:00Z'))); // sent, then voided by removal
    const s = await sendNext(w.deps, w.studentId, w.courseId);
    expect(s).toMatchObject({ status: 'sent', kind: 'assessment', flashcardId: w.assessmentIds[0] });
  });

  it('a card re-opened after a failed post has no stale message_ts', async () => {
    const w = await world({ normal: 1 });
    await db.update(enrollments).set({ assessmentDoneAt: MON }).where(eq(enrollments.userId, w.studentId));
    await seed(w, w.normalIds[0]!, reviewed(new Date('2026-01-04T09:00:00Z'), new Date('2026-01-05T08:00:00Z')));
    await db.update(cardStates).set({ messageChannel: 'Dold', messageTs: '9.9' }).where(eq(cardStates.userId, w.studentId));
    w.slack.failNextPost = new Error('slack down');
    await expect(sendNext(w.deps, w.studentId, w.courseId)).rejects.toThrow('slack down');
    expect(await getOpenCard(db, w.studentId, w.courseId)).toMatchObject({ messageChannel: null, messageTs: null });
  });

  it('S21: a card answered at 14:00 with scheduled_days 3 is sent at the 09:00 tick on day 3, not day 4', async () => {
    const w = await world({ normal: 1, start: new Date('2026-01-08T08:00:00Z') }); // 09:00 Zurich on day 3
    await db.update(enrollments).set({ assessmentDoneAt: MON }).where(eq(enrollments.userId, w.studentId));
    await seed(w, w.normalIds[0]!, reviewed(new Date('2026-01-05T13:00:00Z'), new Date('2026-01-08T13:00:00Z'), { scheduled_days: 3 }));
    expect(await next(w.deps, w.studentId, w.courseId)).toMatchObject({ kind: 'due' });
  });

  it('S22: a course with zero assessment cards sets assessment_done_at in the same call and returns a new card', async () => {
    const w = await world({ assessment: 0, normal: 3 });
    expect((await enrollmentOf(w.studentId)).assessmentDoneAt).toBeNull();
    expect(await sendNext(w.deps, w.studentId, w.courseId)).toMatchObject({ status: 'sent', kind: 'new', flashcardId: w.normalIds[0] });
    const e = await enrollmentOf(w.studentId);
    expect(e.assessmentDoneAt).toEqual(MON);
    expect(e.assessmentScore).toBeNull();
    expect(e.status).toBe('active');
  });

  it('S23: a due just after local midnight in another timezone is selected on the right local day', async () => {
    // Auckland is UTC+13 in January: local midnight of 11 January is 2026-01-10T11:00:00Z.
    const due = new Date('2026-01-10T11:00:01Z');
    const w = await world({ tz: 'Pacific/Auckland', normal: 1, start: new Date('2026-01-10T10:00:00Z') }); // 23:00 on the 10th
    await db.update(enrollments).set({ assessmentDoneAt: MON }).where(eq(enrollments.userId, w.studentId));
    await seed(w, w.normalIds[0]!, reviewed(new Date('2026-01-09T09:00:00Z'), due));
    expect(await next(w.deps, w.studentId, w.courseId)).toBeNull();
    w.clock.set(new Date('2026-01-10T12:00:00Z')); // 01:00 on the 11th
    expect(await next(w.deps, w.studentId, w.courseId)).toMatchObject({ kind: 'due' });
  });

  it('S17: a card added mid-course joins the pool and is introduced by position, after the earlier ones', async () => {
    const w = await world({ normal: 2, endsAt: new Date('2026-01-20T22:59:00Z') });
    await db.update(enrollments).set({ assessmentDoneAt: MON }).where(eq(enrollments.userId, w.studentId));
    await seed(w, w.normalIds[0]!, reviewed(new Date('2026-01-01T09:00:00Z'), new Date('2026-02-01T09:00:00Z'), { learnedAt: new Date('2026-01-02T09:00:00Z') }));
    const [added] = await db.insert(flashcards).values({ courseId: w.courseId, question: 'new', options: ['a', 'b'], correctOption: 0, isAssessment: false, position: 500 }).returning();
    const first = await sendNext(w.deps, w.studentId, w.courseId);
    await reply(w, 0, 'medium');
    w.clock.advanceDays(1);
    const second = await sendNext(w.deps, w.studentId, w.courseId);
    expect(first).toMatchObject({ kind: 'new', flashcardId: w.normalIds[1] });
    expect(second).toMatchObject({ kind: 'new', flashcardId: added!.id });
  });

  it('S36: streak 2 with a short gap is not learned, so the card is still due and selected', async () => {
    const w = await world({ normal: 1 });
    await db.update(enrollments).set({ assessmentDoneAt: MON }).where(eq(enrollments.userId, w.studentId));
    await seed(w, w.normalIds[0]!, reviewed(new Date('2026-01-04T09:00:00Z'), new Date('2026-01-05T09:00:00Z'), { correctStreak: 2 }));
    expect(await next(w.deps, w.studentId, w.courseId)).toMatchObject({ kind: 'due' });
  });

  it('S38: a card introduced 5 days before ends_at cannot be learned; progress shows it unlearned at ends_at', async () => {
    const w = await world({ normal: 1, start: new Date('2026-01-11T09:00:00Z'), endsAt: ENDS }); // ends Friday 16th 23:59, introduced Sunday 11th
    const sent = await sendNext(w.deps, w.studentId, w.courseId);
    expect(sent.status).toBe('sent');
    const day = (d: string) => w.clock.set(new Date(`${d}T08:00:00Z`));
    await reply(w, 0, 'medium'); // 11th: due 13th
    for (const d of ['2026-01-13', '2026-01-14', '2026-01-15']) {
      day(d);
      const s = await sendNext(w.deps, w.studentId, w.courseId);
      if (s.status === 'sent') await reply(w, 0, 'medium');
    }
    const state = (await getCardState(db, w.studentId, w.normalIds[0]!))!.state;
    expect(state.learnedAt).toBeNull();
    w.clock.set(new Date('2026-01-16T23:00:00Z'));
    await finishCourse(w.deps, w.courseId);
    expect(await enrollmentOf(w.studentId)).toMatchObject({ status: 'completed', completedProgress: 0 });
  });
});

describe('the clamp fix: a card answered on the last day is not selected again (decision 0025 amendment)', () => {
  it('answering the same clamped card repeatedly on dueNotAfter day stops after one answer', async () => {
    const w = await world({ normal: 1, start: new Date('2026-01-15T08:00:00Z') }); // Thursday 15 January 09:00, the day of dueNotAfter
    await db.update(enrollments).set({ assessmentDoneAt: MON }).where(eq(enrollments.userId, w.studentId));
    await seed(w, w.normalIds[0]!, reviewed(new Date('2026-01-14T08:00:00Z'), new Date('2026-01-15T22:59:59.999Z'), { correctStreak: 1 }));
    let answers = 0;
    for (let i = 0; i < 5; i++) {
      const s = await sendNext(w.deps, w.studentId, w.courseId);
      if (s.status !== 'sent') break;
      await reply(w, 0, 'medium');
      answers += 1;
      w.clock.set(new Date(w.clock.now().getTime() + 60_000));
    }
    expect(answers).toBe(1);
    const state = (await getCardState(db, w.studentId, w.normalIds[0]!))!.state;
    expect(state.learnedAt).toBeNull(); // gap 1 day
    expect(state.due.getTime()).toBeGreaterThan(new Date('2026-01-15T22:59:59.999Z').getTime());
    const rows = await db.select().from(reviews).where(eq(reviews.userId, w.studentId));
    expect(rows).toHaveLength(1);
  });
});

describe('first cards at course start and at enrollment', () => {
  it('sends the first assessment card to every present active student, no SEND_HOUR gate', async () => {
    const w = await world({ assessment: 2, normal: 3, start: new Date('2026-01-05T02:00:00Z') }); // 03:00 Zurich, before any SEND_HOUR
    const exempt = await addStudent(w, 'exempt');
    const removed = await addStudent(w, 'active', MON);
    const noSlack = await addStudent(w, 'active', null, null);
    const other = await addStudent(w);
    expect(await sendFirstCards(w.deps, w.courseId)).toBe(2);
    expect(w.slack.posted).toHaveLength(2);
    for (const id of [exempt, removed, noSlack]) expect(await getCardState(db, id, w.assessmentIds[0]!)).toBeNull();
    expect(await getCardState(db, other, w.assessmentIds[0]!)).toMatchObject({ messageChannel: expect.any(String) });
    expect(await sendFirstCards(w.deps, w.courseId)).toBe(0); // repeating sends nothing: the cards are open
  });

  it('enrolling into an active course is the same call for one student', async () => {
    const w = await world({ assessment: 1, normal: 1 });
    expect(await sendNext(w.deps, w.studentId, w.courseId)).toMatchObject({ status: 'sent', kind: 'assessment' });
  });
});

describe('completion', () => {
  /** Every card of the course learned except `open`, which the student answers now. */
  async function allButOne(w: World) {
    const ids = [...w.assessmentIds, ...w.normalIds];
    await db.update(enrollments).set({ assessmentDoneAt: MON }).where(eq(enrollments.userId, w.studentId));
    for (const id of ids.slice(0, -1)) await seed(w, id, reviewed(new Date('2026-01-01T09:00:00Z'), new Date('2026-02-01T09:00:00Z'), { learnedAt: new Date('2026-01-02T09:00:00Z'), correctStreak: 2 }));
    const last = ids.at(-1)!;
    await seed(w, last, reviewed(new Date('2026-01-01T09:00:00Z'), new Date('2026-01-04T09:00:00Z'), { correctStreak: 1 }));
    return last;
  }

  it('S16: the answer that learns the last card completes the enrollment once, with progress 100 and a message', async () => {
    const w = await world({ assessment: 1, normal: 2 });
    await allButOne(w);
    expect((await sendNext(w.deps, w.studentId, w.courseId)).status).toBe('sent');
    w.clock.set(new Date('2026-01-12T09:00:00Z')); // gap well over 7 days
    const { result, sent } = await reply(w, 0, 'medium');
    expect(result.status === 'answered' && result.state.learnedAt).toEqual(w.clock.now());
    expect(sent).toEqual({ status: 'none' });
    const e = await enrollmentOf(w.studentId);
    expect(e).toMatchObject({ status: 'completed', completedProgress: 100 });
    expect(e.completedAt).toEqual(w.clock.now());
    expect(textOf(w.slack.posted.at(-1)!)).toBe(TEXT.completed);
    expect(await sendNext(w.deps, w.studentId, w.courseId)).toEqual({ status: 'none' });
  });

  it('S28: at ends_at with 6 of 10 learned the enrollment is completed at 60, the course finished, nothing sent afterwards', async () => {
    // ends_at far in the past of every other test course, so finishEndedCourses finishes only this one in the shared database
    const w = await world({ normal: 10, endsAt: new Date('2000-01-10T12:00:00Z'), start: new Date('2000-01-05T09:00:00Z') });
    await db.update(enrollments).set({ assessmentDoneAt: MON }).where(eq(enrollments.userId, w.studentId));
    for (const id of w.normalIds.slice(0, 6)) await seed(w, id, reviewed(new Date('2026-01-01T09:00:00Z'), new Date('2026-02-01T09:00:00Z'), { learnedAt: new Date('2026-01-09T09:00:00Z') }));
    const open = await sendNext(w.deps, w.studentId, w.courseId);
    expect(open.status).toBe('sent');
    w.clock.set(new Date('2000-01-10T13:00:00Z'));
    expect(await sendNext(w.deps, w.studentId, w.courseId)).toEqual({ status: 'none' }); // ends_at passed: nothing, even before the tick completes it
    expect(await finishEndedCourses(w.deps, [w.courseId])).toEqual([w.courseId]);
    const e = await enrollmentOf(w.studentId);
    expect(e).toMatchObject({ status: 'completed', completedProgress: 60 });
    expect(e.completedAt).toEqual(w.clock.now());
    const [c] = await db.select().from(courses).where(eq(courses.id, w.courseId));
    expect(c!.status).toBe('finished');
    expect(textOf(w.slack.posted.at(-1)!)).toBe(TEXT.ended(60));
    expect(w.slack.replaced).toHaveLength(1); // the open card's message
    expect(w.slack.replaced[0]).toMatchObject({ channel: (open as { channel: string }).channel, ts: (open as { ts: string }).ts });
    expect(await sendNext(w.deps, w.studentId, w.courseId)).toEqual({ status: 'none' });
    expect(await finishEndedCourses(w.deps, [w.courseId])).toEqual([]); // finished once
  });

  it('S29: cards added to the course after completion do not reopen the enrollment, progress stays 60', async () => {
    const w = await world({ normal: 10, endsAt: new Date('2026-01-31T22:59:00Z') });
    await db.update(enrollments).set({ assessmentDoneAt: MON }).where(eq(enrollments.userId, w.studentId));
    for (const id of w.normalIds.slice(0, 6)) await seed(w, id, reviewed(new Date('2026-01-01T09:00:00Z'), new Date('2026-02-01T09:00:00Z'), { learnedAt: new Date('2026-01-09T09:00:00Z') }));
    await finishCourse(w.deps, w.courseId); // a manual stop completes the same way
    await db.insert(flashcards).values({ courseId: w.courseId, question: 'late', options: ['a', 'b'], correctOption: 0, isAssessment: false, position: 900 });
    expect(await enrollmentOf(w.studentId)).toMatchObject({ status: 'completed', completedProgress: 60 });
    expect(await sendNext(w.deps, w.studentId, w.courseId)).toEqual({ status: 'none' });
  });

  it('S30: an exempt student stays exempt at ends_at; a removed one is not completed (S39, the course part)', async () => {
    const w = await world({ normal: 2 });
    const exempt = await addStudent(w, 'exempt');
    const removed = await addStudent(w, 'active', MON);
    w.clock.set(new Date('2026-01-17T00:00:00Z'));
    await finishCourse(w.deps, w.courseId);
    expect(await enrollmentOf(exempt)).toMatchObject({ status: 'exempt', completedAt: null, completedProgress: null });
    expect(await enrollmentOf(removed)).toMatchObject({ status: 'active', completedAt: null });
    expect(await enrollmentOf(w.studentId)).toMatchObject({ status: 'completed' });
  });

  it('a click on an open card after completion is refused as course_over (S31 with the scheduler)', async () => {
    const w = await world({ normal: 2 });
    await sendNext(w.deps, w.studentId, w.courseId);
    const open = (await getOpenCard(db, w.studentId, w.courseId))!;
    w.clock.set(new Date('2026-01-17T00:00:00Z'));
    await finishCourse(w.deps, w.courseId);
    expect(await submitAnswer(w.deps, { userId: w.studentId, flashcardId: open.flashcardId, chosenOption: 0, rating: 'easy' })).toEqual({ status: 'rejected', reason: 'course_over' });
  });

  it('afterAnswer does nothing for a rejected answer', async () => {
    const w = await world({ normal: 1 });
    expect(await afterAnswer(w.deps, w.studentId, w.courseId, { status: 'rejected', reason: 'not_open' })).toEqual({ status: 'none' });
    expect(w.slack.posted).toHaveLength(0);
  });
});

describe('no real clock', () => {
  it('scheduler.ts reads time only from the injected clock', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./scheduler.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/new Date\(\)|Date\.now/);
  });
});

describe('image cards (decision 0034)', () => {
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  it('I1: the card is posted with its image (1200x630 PNG, alt = the question) and the text stays question plus options', async () => {
    const w = await world({ normal: 1 });
    await sendNext(w.deps, w.studentId, w.courseId);
    const p = w.slack.posted[0]!;
    expect(p.image).toMatchObject({ width: 1200, height: 630, alt: 'Q100' });
    expect(p.image!.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(p.message.text).toBe('Q: Q100\n1. a\n2. b\n3. c');
    expect(p.message.blocks.map((b) => b.type)).toEqual(['section', 'actions']); // the port puts the image block first
    expect(JSON.stringify(p.message.blocks)).not.toContain('Q100'); // the question is on the image only
    expect((await getOpenCard(db, w.studentId, w.courseId))?.messageTs).toBe(p.ts);
  });

  it.each([['upload_failed'], ['not_ready'], ['no_file_id']] as const)('I2: an image failure (%s) sends the text card, logs a short code and records the delivery', async (code) => {
    const warn = quiet();
    const w = await world({ normal: 1 });
    w.slack.failNextImage = new CardImageError(code);
    await sendNext(w.deps, w.studentId, w.courseId);
    expect(w.slack.posted).toHaveLength(1);
    expect(w.slack.posted[0]!.image).toBeUndefined();
    expect(w.slack.posted[0]!.message.blocks[0]).toMatchObject({ type: 'section', text: { text: expect.stringContaining('Q100') } }); // the question is in the text card
    expect((await getOpenCard(db, w.studentId, w.courseId))?.messageTs).toBe(w.slack.posted[0]!.ts);
    expect(warn.mock.calls.flat().join(' ')).toContain(code);
    warn.mockRestore();
  });

  it('I3: a question that cannot be drawn (stored before the rule) is sent as text: the claim does not loop', async () => {
    const warn = quiet();
    const w = await world({ normal: 1 });
    await db.update(flashcards).set({ question: 'Is it fine \u{1F600}?' }).where(eq(flashcards.id, w.normalIds[0]!));
    await sendNext(w.deps, w.studentId, w.courseId);
    expect(w.slack.posted[0]!.image).toBeUndefined();
    expect(w.slack.posted[0]!.message.text).toContain('\u{1F600}');
    expect(warn.mock.calls.flat().join(' ')).toContain('unsupported_character');
    warn.mockRestore();
  });

  it('I4: any other Slack failure propagates, the claim stays, and the stale-claim re-send posts the image again', async () => {
    const w = await world({ normal: 1 });
    w.slack.failNextPost = new Error('Slack down');
    await expect(sendNext(w.deps, w.studentId, w.courseId)).rejects.toThrow('Slack down');
    expect(w.slack.posted).toHaveLength(0);
    expect((await getOpenCard(db, w.studentId, w.courseId))?.messageTs).toBeNull();
    w.clock.set(new Date(w.clock.now().getTime() + 11 * 60_000));
    expect(await resendStaleClaim(w.deps, w.studentId, w.courseId, 10 * 60_000)).toBe(true);
    expect(w.slack.posted).toHaveLength(1);
    expect(w.slack.posted[0]!.image).toMatchObject({ width: 1200, height: 630, alt: 'Q100' });
  });

  it('I5: a message that is not a card (course start, ended, exempt) is posted without an image', async () => {
    const w = await world({ normal: 1 });
    const { dm } = await import('./scheduler.js');
    await dm(w.deps, w.studentId, TEXT.started);
    expect(w.slack.posted[0]!.image).toBeUndefined();
  });

  it('I6: a renderer that throws (missing font, native failure) sends the text card and logs only the error name', async () => {
    const warn = quiet();
    const spy = vi.spyOn(renderModule, 'renderCard').mockImplementation(() => { throw new Error('canvas exploded /secret/path'); });
    const w = await world({ normal: 1 });
    await sendNext(w.deps, w.studentId, w.courseId);
    spy.mockRestore();
    expect(w.slack.posted[0]!.image).toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('render_threw Error');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret');
    warn.mockRestore();
  });
});
