import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createControlledClock } from '../clock.js';
import { applyAnswer, MissingRatingError, newCardState, type CardState } from '../domain/calculator.js';
import { getCardState, upsertCardState } from '../db/cardStates.js';
import { cardStates, courses, enrollments, flashcards, reviews, users } from '../db/schema.js';
import { db, pool } from '../db/testDb.js';
import { InvalidOptionError, submitAnswer, type AnswerDeps } from './answer.js';

afterAll(() => pool.end());

const Z = 'Europe/Zurich';
const MON = new Date('2026-01-05T13:06:00Z'); // Monday 14:06 Zurich, walkthrough section 3
const ENDS = new Date('2026-01-16T22:59:00Z'); // Friday 16 January 23:59 Zurich

interface World {
  studentId: string;
  courseId: string;
  assessmentIds: string[];
  normalIds: string[];
  deps: AnswerDeps;
  clock: ReturnType<typeof createControlledClock>;
}

async function world(o: { tz?: string | null; endsAt?: Date; assessment?: number; normal?: number; threshold?: number; tenantTz?: string } = {}): Promise<World> {
  const tag = crypto.randomUUID();
  const [teacher] = await db.insert(users).values({ fullName: 'T', email: `t-${tag}@x.test`, role: 'teacher' }).returning();
  const [student] = await db
    .insert(users)
    .values({ fullName: 'S', email: `s-${tag}@x.test`, role: 'student', tz: o.tz === undefined ? Z : o.tz })
    .returning();
  const [course] = await db
    .insert(courses)
    .values({
      teacherId: teacher!.id, title: 'C', materialUrl: 'https://course.test', status: 'active', startsAt: MON,
      endsAt: o.endsAt ?? ENDS, assessmentPassThreshold: o.threshold ?? 90,
    })
    .returning();
  const make = async (n: number, isAssessment: boolean, from: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [c] = await db
        .insert(flashcards)
        .values({ courseId: course!.id, question: 'Q', options: ['a', 'b', 'c'], correctOption: 0, isAssessment, position: from + i })
        .returning();
      ids.push(c!.id);
    }
    return ids;
  };
  const assessmentIds = await make(o.assessment ?? 0, true, 1);
  const normalIds = await make(o.normal ?? 1, false, 100);
  await db.insert(enrollments).values({ courseId: course!.id, userId: student!.id, status: 'active', enrolledAt: MON });
  const clock = createControlledClock(MON);
  return { studentId: student!.id, courseId: course!.id, assessmentIds, normalIds, clock, deps: { db, clock, tenantTimezone: o.tenantTz ?? 'UTC' } };
}

/** Stands in for the scheduler's send (Task 6): opens the card at the clock's time. */
async function send(w: World, flashcardId: string, over: Partial<{ state: CardState; messageTs: string | null; remindedAt: Date | null; reminderCount: number; sentAt: Date }> = {}) {
  const at = w.clock.now();
  const existing = await getCardState(db, w.studentId, flashcardId);
  await upsertCardState(db, {
    userId: w.studentId,
    flashcardId,
    state: over.state ?? existing?.state ?? newCardState(at),
    introducedAt: existing?.introducedAt ?? at,
    sentAt: over.sentAt ?? at,
    remindedAt: over.remindedAt ?? null,
    reminderCount: over.reminderCount ?? 0,
    messageChannel: 'D1',
    messageTs: over.messageTs === undefined ? '1.1' : over.messageTs,
  });
  return at;
}

const reviewRows = (w: World, flashcardId: string) =>
  db.select().from(reviews).where(and(eq(reviews.userId, w.studentId), eq(reviews.flashcardId, flashcardId)));
const answer = (w: World, flashcardId: string, chosenOption: number | null, rating?: 'hard' | 'medium' | 'easy', messageTs?: string) =>
  submitAnswer(w.deps, { userId: w.studentId, flashcardId, chosenOption, ...(rating && { rating }), ...(messageTs && { messageTs }) });
const enrollment = async (w: World) => (await db.select().from(enrollments).where(eq(enrollments.userId, w.studentId)))[0]!;

/** A reviewed card for the clamp tests: FSRS will schedule far beyond the course end. */
const matureState = (lastReview: Date, extra: Partial<CardState> = {}): CardState => ({
  ...newCardState(lastReview), state: 2, reps: 3, stability: 50, difficulty: 5, scheduled_days: 40, last_review: lastReview, due: new Date(lastReview.getTime() + 4 * 864e5), ...extra,
});

describe('S10: the answer closes the delivery', () => {
  it('stores the review, clears sent_at and the reminder counters, keeps the delivery key', async () => {
    const w = await world();
    const [id] = w.normalIds;
    const sentAt = await send(w, id!, { remindedAt: new Date('2026-01-05T20:00:00Z'), reminderCount: 1 });
    w.clock.set(new Date('2026-01-05T13:10:00Z'));
    const r = await answer(w, id!, 0, 'medium');
    expect(r.status).toBe('answered');
    if (r.status !== 'answered') return;
    expect(r.review).toMatchObject({ isCorrect: true, rating: 'medium', reviewedAt: w.clock.now() });
    expect(r.correctOption).toBe(0);
    expect(r.materialUrl).toBe('https://course.test');
    const rec = await getCardState(db, w.studentId, id!);
    expect(rec).toMatchObject({ sentAt: null, remindedAt: null, reminderCount: 0 });
    expect(rec?.state.correctStreak).toBe(1);
    expect(rec?.state.last_review).toEqual(w.clock.now());
    const rows = await reviewRows(w, id!);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deliverySentAt).toEqual(sentAt);
  });

  it('a wrong answer and "Don\'t know" store a null rating and Again', async () => {
    const w = await world({ normal: 2 });
    await send(w, w.normalIds[0]!);
    const wrong = await answer(w, w.normalIds[0]!, 1, 'easy'); // rating ignored
    await send(w, w.normalIds[1]!);
    const dk = await answer(w, w.normalIds[1]!, null);
    expect(wrong.status === 'answered' && wrong.review).toMatchObject({ isCorrect: false, rating: null });
    expect(dk.status === 'answered' && dk.review).toMatchObject({ chosenOption: null, isCorrect: false, rating: null });
  });

  it('uses the course material when the card has none, the card material when it has', async () => {
    const w = await world();
    await db.update(flashcards).set({ materialUrl: 'https://card.test' }).where(eq(flashcards.id, w.normalIds[0]!));
    await send(w, w.normalIds[0]!);
    const r = await answer(w, w.normalIds[0]!, 1);
    expect(r.status === 'answered' && r.materialUrl).toBe('https://card.test');
  });
});

describe('S2, S4: the last assessment answer evaluates once', () => {
  it('walkthrough section 2: Easy, Medium, Don\'t know gives 33%, not exempt, only the Easy card learned', async () => {
    const w = await world({ assessment: 3, normal: 1 });
    const [a1, a2, a3] = w.assessmentIds as [string, string, string];
    await send(w, a1);
    const r1 = await answer(w, a1, 0, 'easy');
    await send(w, a2);
    const r2 = await answer(w, a2, 0, 'medium');
    expect(r1.status === 'answered' && r1.assessment).toBeNull();
    expect(r2.status === 'answered' && r2.assessment).toBeNull();
    expect((await enrollment(w)).assessmentDoneAt).toBeNull();

    w.clock.set(new Date('2026-01-05T13:05:00Z'));
    await send(w, a3);
    const r3 = await answer(w, a3, null);
    expect(r3.status === 'answered' && r3.assessment).toMatchObject({ exempt: false, learnedFlashcardIds: [a1] });
    const e = await enrollment(w);
    expect(e.assessmentDoneAt).toEqual(w.clock.now());
    expect(e.assessmentScore).toBeCloseTo(100 / 3, 5);
    expect(e.status).toBe('active');
    const learned = async (id: string) => (await getCardState(db, w.studentId, id))?.state.learnedAt ?? null;
    expect(await learned(a1)).toEqual(w.clock.now());
    expect(await learned(a2)).toBeNull();
    expect(await learned(a3)).toBeNull();
    // the others continue in FSRS with their own state
    expect((await getCardState(db, w.studentId, a2))?.state.correctStreak).toBe(1);

    // the evaluation does not run again: a repeated click is refused and the row is untouched
    w.clock.advanceDays(1);
    expect(await answer(w, a3, 0, 'easy')).toEqual({ status: 'rejected', reason: 'not_open' });
    expect((await enrollment(w)).assessmentDoneAt).toEqual(new Date('2026-01-05T13:05:00Z'));
  });

  it('a passed card answered last shows learnedAt in the returned state', async () => {
    const w = await world({ assessment: 2, threshold: 100 });
    await send(w, w.assessmentIds[0]!);
    await answer(w, w.assessmentIds[0]!, 1); // wrong
    await send(w, w.assessmentIds[1]!);
    const r = await answer(w, w.assessmentIds[1]!, 0, 'easy');
    expect(r.status === 'answered' && r.state.learnedAt).toEqual(w.clock.now());
  });

  it('Hard or Medium on an assessment card is not a pass', async () => {
    const w = await world({ assessment: 2 });
    await send(w, w.assessmentIds[0]!);
    await answer(w, w.assessmentIds[0]!, 0, 'hard');
    await send(w, w.assessmentIds[1]!);
    const r = await answer(w, w.assessmentIds[1]!, 0, 'medium');
    expect(r.status === 'answered' && r.assessment).toMatchObject({ score: 0, exempt: false, learnedFlashcardIds: [] });
  });

  it('a normal card answered while the assessment is open does not evaluate', async () => {
    const w = await world({ assessment: 1, normal: 1 });
    await send(w, w.normalIds[0]!);
    const r = await answer(w, w.normalIds[0]!, 0, 'easy');
    expect(r.status === 'answered' && r.assessment).toBeNull();
    expect((await enrollment(w)).assessmentDoneAt).toBeNull();
  });
});

describe('S3: exempt student', () => {
  it('all Easy: status exempt, score 100, done_at set, no card left open', async () => {
    const w = await world({ assessment: 3 });
    for (const id of w.assessmentIds) {
      await send(w, id);
      await answer(w, id, 0, 'easy');
    }
    const e = await enrollment(w);
    expect(e).toMatchObject({ status: 'exempt', assessmentScore: 100 });
    expect(e.assessmentDoneAt).toEqual(w.clock.now());
    const open = await db.select().from(cardStates).where(eq(cardStates.userId, w.studentId));
    expect(open.every((r) => r.sentAt === null)).toBe(true);
    expect(open.every((r) => r.learnedAt === null)).toBe(true); // decision 0025 #14
  });

  it('a score equal to the threshold exempts (inclusive)', async () => {
    const w = await world({ assessment: 2, threshold: 50 });
    await send(w, w.assessmentIds[0]!);
    await answer(w, w.assessmentIds[0]!, 0, 'easy');
    await send(w, w.assessmentIds[1]!);
    await answer(w, w.assessmentIds[1]!, 2);
    expect((await enrollment(w)).status).toBe('exempt');
  });
});

describe('S13: a repeated delivery is ignored', () => {
  it('a review already stored for this delivery gives duplicate and changes nothing', async () => {
    const w = await world();
    const id = w.normalIds[0]!;
    const sentAt = await send(w, id);
    await db.insert(reviews).values({ userId: w.studentId, flashcardId: id, chosenOption: 0, isCorrect: true, rating: 'easy', reviewedAt: sentAt, deliverySentAt: sentAt });
    expect(await answer(w, id, 0, 'medium')).toEqual({ status: 'duplicate' });
    expect(await reviewRows(w, id)).toHaveLength(1);
    expect((await getCardState(db, w.studentId, id))?.sentAt).toEqual(sentAt); // state untouched
  });

  it('two clicks at the same time: one review row, one answered, the other ignored', async () => {
    for (let i = 0; i < 5; i++) {
      const w = await world();
      const id = w.normalIds[0]!;
      await send(w, id);
      const results = await Promise.all([answer(w, id, 0, 'medium'), answer(w, id, 0, 'medium')]);
      expect(results.filter((r) => r.status === 'answered')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'duplicate' || (r.status === 'rejected' && r.reason === 'not_open'))).toHaveLength(1);
      expect(await reviewRows(w, id)).toHaveLength(1);
      expect((await getCardState(db, w.studentId, id))?.state.reps).toBe(1);
    }
  });
});

describe('rejections store nothing', () => {
  const nothingStored = async (w: World, id: string) => {
    expect(await reviewRows(w, id)).toHaveLength(0);
  };

  it('S14: no card_states row, and a card that is not open', async () => {
    const w = await world();
    const id = w.normalIds[0]!;
    expect(await answer(w, id, 0, 'easy')).toEqual({ status: 'rejected', reason: 'not_open' });
    await send(w, id);
    await db.update(cardStates).set({ sentAt: null }).where(eq(cardStates.userId, w.studentId));
    expect(await answer(w, id, 0, 'easy')).toEqual({ status: 'rejected', reason: 'not_open' });
    await nothingStored(w, id);
  });

  it('S14: another student does not own the open card; an unknown card is not open', async () => {
    const w = await world();
    const other = await world();
    await send(w, w.normalIds[0]!);
    const r = await submitAnswer(w.deps, { userId: other.studentId, flashcardId: w.normalIds[0]!, chosenOption: 0, rating: 'easy' });
    expect(r).toEqual({ status: 'rejected', reason: 'not_enrolled' });
    expect(await answer(w, crypto.randomUUID(), 0, 'easy')).toEqual({ status: 'rejected', reason: 'not_open' });
    await nothingStored(w, w.normalIds[0]!);
  });

  it('S31: completed enrollment, exempt enrollment and finished course are "course over"', async () => {
    for (const change of ['completed', 'exempt', 'finished'] as const) {
      const w = await world();
      const id = w.normalIds[0]!;
      await send(w, id);
      if (change !== 'finished') await db.update(enrollments).set({ status: change }).where(eq(enrollments.userId, w.studentId));
      else await db.update(courses).set({ status: 'finished' }).where(eq(courses.id, w.courseId));
      expect(await answer(w, id, 0, 'easy')).toEqual({ status: 'rejected', reason: 'course_over' });
      await nothingStored(w, id);
      expect((await getCardState(db, w.studentId, id))?.sentAt).not.toBeNull();
    }
  });

  it('S33: a click on the older message after a reminder is "sent again"', async () => {
    const w = await world();
    const id = w.normalIds[0]!;
    await send(w, id, { messageTs: '2.2', remindedAt: new Date('2026-01-06T09:00:00Z'), reminderCount: 1 });
    expect(await answer(w, id, 0, 'easy', '1.1')).toEqual({ status: 'rejected', reason: 'sent_again' });
    await nothingStored(w, id);
    expect((await getCardState(db, w.studentId, id))?.state.reps).toBe(0);
  });

  it('S34: the answer to the reminder message closes the original delivery once', async () => {
    const w = await world();
    const id = w.normalIds[0]!;
    const sentAt = await send(w, id);
    await send(w, id, { sentAt, messageTs: '2.2', remindedAt: new Date('2026-01-06T13:06:00Z'), reminderCount: 1 });
    w.clock.set(new Date('2026-01-06T15:00:00Z'));
    expect((await answer(w, id, 0, 'medium', '2.2')).status).toBe('answered');
    const rows = await reviewRows(w, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deliverySentAt).toEqual(sentAt);
  });

  it('S41: removed student with a voided card gets "removed", not "not open"', async () => {
    const w = await world();
    const id = w.normalIds[0]!;
    await send(w, id);
    await db.update(cardStates).set({ sentAt: null, messageTs: null }).where(eq(cardStates.userId, w.studentId));
    await db.update(enrollments).set({ removedAt: MON }).where(eq(enrollments.userId, w.studentId));
    expect(await answer(w, id, 0, 'easy')).toEqual({ status: 'rejected', reason: 'removed' });
    await nothingStored(w, id);
  });

  it('an option outside the card and a right answer without a rating throw and leave no review', async () => {
    const w = await world();
    const id = w.normalIds[0]!;
    await send(w, id);
    await expect(answer(w, id, 3, 'easy')).rejects.toThrow(InvalidOptionError);
    await expect(answer(w, id, -1)).rejects.toThrow(InvalidOptionError);
    await expect(answer(w, id, 0)).rejects.toThrow(MissingRatingError);
    await nothingStored(w, id);
    expect((await getCardState(db, w.studentId, id))?.sentAt).not.toBeNull();
  });
});

describe('the due clamp', () => {
  /** Walkthrough section 3: Monday Medium, Wednesday Medium; FSRS wants Sunday 18 January. */
  async function mondayAndWednesday(w: World) {
    const id = w.normalIds[0]!;
    await send(w, id);
    await answer(w, id, 0, 'medium');
    w.clock.set(new Date('2026-01-07T08:15:00Z'));
    await send(w, id);
    return { id, r: await answer(w, id, 0, 'medium') };
  }

  it('S49: a due after dueNotAfter is clamped to the end of Thursday; scheduled_days stays as FSRS gave it', async () => {
    const w = await world();
    const { id, r } = await mondayAndWednesday(w);
    expect(r.status === 'answered' && r.clampedFrom).toEqual(new Date('2026-01-18T08:15:00Z'));
    const s = (await getCardState(db, w.studentId, id))!.state;
    expect(s.due).toEqual(new Date('2026-01-15T22:59:59.999Z'));
    expect(s.scheduled_days).toBe(11);
    expect(s.correctStreak).toBe(2);
    expect(s.learnedAt).toBeNull(); // gap 1.8 days
  });

  it('S50: a due before dueNotAfter is unchanged', async () => {
    const w = await world();
    const id = w.normalIds[0]!;
    await send(w, id);
    const r = await answer(w, id, 0, 'medium');
    expect(r.status === 'answered' && r.clampedFrom).toBeNull();
    expect((await getCardState(db, w.studentId, id))?.state.due).toEqual(new Date('2026-01-07T13:06:00Z'));
  });

  it('S51: answering on the last day or later is not clamped', async () => {
    const w = await world({ endsAt: new Date('2026-01-05T20:00:00Z') }); // limit is the end of 4 January, before now
    const id = w.normalIds[0]!;
    await send(w, id);
    const r = await answer(w, id, 0, 'medium');
    expect(r.status === 'answered' && r.clampedFrom).toBeNull();
    expect((await getCardState(db, w.studentId, id))?.state.due).toEqual(new Date('2026-01-07T13:06:00Z'));
  });

  it('S52: a clamped card answered right and Medium 5 days later (streak 2) is not learned', async () => {
    const w = await world({ endsAt: new Date('2026-01-12T22:59:00Z') }); // limit: end of Sunday 11 January
    const id = w.normalIds[0]!;
    w.clock.set(new Date('2026-01-11T12:00:00Z'));
    await send(w, id, { state: matureState(new Date('2026-01-06T12:00:00Z'), { correctStreak: 1, due: new Date('2026-01-11T22:59:59.999Z') }) });
    const r = await answer(w, id, 0, 'medium');
    expect(r.status === 'answered' && r.state).toMatchObject({ correctStreak: 2, learnedAt: null });
  });

  it('S37: the limit is the end of the student\'s local day, not of the UTC day', async () => {
    const cases = [
      ['Pacific/Auckland', '2026-01-20T05:00:00Z', '2026-01-19T10:59:59.999Z', '2026-01-10T12:00:00Z'],
      ['America/Los_Angeles', '2026-01-20T05:00:00Z', '2026-01-19T07:59:59.999Z', '2026-01-10T12:00:00Z'],
      ['Europe/Zurich', '2026-03-30T10:00:00Z', '2026-03-29T21:59:59.999Z', '2026-03-10T12:00:00Z'], // spring-forward day, not ends_at minus 24 h
    ] as const;
    for (const [tz, endsAt, expected, answeredAt] of cases) {
      const w = await world({ tz, endsAt: new Date(endsAt) });
      const id = w.normalIds[0]!;
      w.clock.set(new Date(answeredAt));
      await send(w, id, { state: matureState(new Date(new Date(answeredAt).getTime() - 5 * 864e5)) });
      await answer(w, id, 0, 'medium');
      expect((await getCardState(db, w.studentId, id))?.state.due.toISOString(), tz).toBe(expected);
    }
  });

  it('a missing or invalid user timezone falls back to the tenant timezone; the invalid one is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const w = await world({ tz: 'Mars/Olympus', tenantTz: 'Pacific/Auckland', endsAt: new Date('2026-01-20T05:00:00Z') });
      const id = w.normalIds[0]!;
      w.clock.set(new Date('2026-01-10T12:00:00Z'));
      await send(w, id, { state: matureState(new Date('2026-01-05T12:00:00Z')) });
      await answer(w, id, 0, 'medium');
      expect((await getCardState(db, w.studentId, id))?.state.due).toEqual(new Date('2026-01-19T10:59:59.999Z'));
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain(w.studentId);
      expect(String(warn.mock.calls[0]?.[0])).toContain('Mars/Olympus');

      const n = await world({ tz: null, tenantTz: 'Pacific/Auckland', endsAt: new Date('2026-01-20T05:00:00Z') });
      n.clock.set(new Date('2026-01-10T12:00:00Z'));
      await send(n, n.normalIds[0]!, { state: matureState(new Date('2026-01-05T12:00:00Z')) });
      await answer(n, n.normalIds[0]!, 0, 'medium');
      expect((await getCardState(db, n.studentId, n.normalIds[0]!))?.state.due).toEqual(new Date('2026-01-19T10:59:59.999Z'));
      expect(warn).toHaveBeenCalledOnce(); // no warning for a null timezone
    } finally {
      warn.mockRestore();
    }
  });

  it('the stored state equals applyAnswer except for due when clamped (other fields untouched)', async () => {
    const w = await world();
    const id = w.normalIds[0]!;
    w.clock.set(new Date('2026-01-10T12:00:00Z'));
    const before = matureState(new Date('2026-01-05T12:00:00Z'));
    await send(w, id, { state: before });
    await answer(w, id, 0, 'medium');
    const expected = applyAnswer({ correctOption: 0 }, before, { chosenOption: 0, rating: 'medium' }, w.clock.now()).state;
    expect((await getCardState(db, w.studentId, id))?.state).toEqual({ ...expected, due: new Date('2026-01-15T22:59:59.999Z') });
  });
});

describe('time', () => {
  it('the service never reads the real clock', () => {
    const src = readFileSync(new URL('./answer.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/new Date\(\)|Date\.now\(|performance\.now/);
  });
});
