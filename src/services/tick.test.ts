import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createControlledClock } from '../clock.js';
import { newCardState, type CardState } from '../domain/calculator.js';
import { getCardState, upsertCardState } from '../db/cardStates.js';
import { getOpenCard } from '../db/selection.js';
import { cardStates, courses, enrollments, flashcards, users } from '../db/schema.js';
import { db, pool } from '../db/testDb.js';
import type { CardMessage } from '../slack/card.js';
import { FakeSlack } from '../slack/fake.js';
import { submitAnswer } from './answer.js';
import { afterAnswer, type SchedulerDeps } from './scheduler.js';
import { resendStaleClaim } from './scheduler.js';
import { runTick, startTick } from './tick.js';

afterAll(() => pool.end());

const Z = 'Europe/Zurich';

interface World {
  studentId: string;
  courseId: string;
  cardIds: string[];
  slack: FakeSlack;
  clock: ReturnType<typeof createControlledClock>;
  deps: SchedulerDeps;
  cfg: { sendHour: number; courseIds: string[] };
}

async function world(o: { start: string; endsAt?: string; tz?: string | null; slackId?: string | null; cards?: number; slack?: FakeSlack }): Promise<World> {
  const tag = crypto.randomUUID();
  const [teacher] = await db.insert(users).values({ fullName: 'T', email: `t-${tag}@x.test`, role: 'teacher' }).returning();
  const [student] = await db
    .insert(users)
    .values({ fullName: 'S', email: `s-${tag}@x.test`, role: 'student', tz: o.tz === undefined ? Z : o.tz, slackId: o.slackId === undefined ? `U${tag}` : o.slackId })
    .returning();
  const [course] = await db
    .insert(courses)
    .values({ teacherId: teacher!.id, title: 'C', materialUrl: 'https://course.test', status: 'active', startsAt: new Date(o.start), endsAt: new Date(o.endsAt ?? '2099-01-01T00:00:00Z') })
    .returning();
  const cardIds: string[] = [];
  for (let i = 0; i < (o.cards ?? 1); i++) {
    const [c] = await db.insert(flashcards).values({ courseId: course!.id, question: `Q${i}`, options: ['a', 'b'], correctOption: 0, isAssessment: false, position: i + 1 }).returning();
    cardIds.push(c!.id);
  }
  await db.insert(enrollments).values({ courseId: course!.id, userId: student!.id, status: 'active', enrolledAt: new Date(o.start), assessmentDoneAt: new Date(o.start) });
  const clock = createControlledClock(new Date(o.start));
  const slack = o.slack ?? new FakeSlack();
  return { studentId: student!.id, courseId: course!.id, cardIds, slack, clock, deps: { db, clock, tenantTimezone: 'UTC', slack }, cfg: { sendHour: 9, courseIds: [course!.id] } };
}

const addStudent = async (w: World) => {
  const tag = crypto.randomUUID();
  const [s] = await db.insert(users).values({ fullName: 'S2', email: `s2-${tag}@x.test`, role: 'student', tz: Z, slackId: `U${tag}` }).returning();
  await db.insert(enrollments).values({ courseId: w.courseId, userId: s!.id, status: 'active', enrolledAt: new Date(), assessmentDoneAt: new Date() });
  return s!.id;
};

const reviewed = (lastReview: Date, due: Date): CardState => ({ ...newCardState(lastReview), state: 2, reps: 2, stability: 3, difficulty: 5, scheduled_days: 2, last_review: lastReview, due });
const seed = (w: World, flashcardId: string, state: CardState) =>
  upsertCardState(db, { userId: w.studentId, flashcardId, state, introducedAt: new Date('2026-01-01T00:00:00Z'), sentAt: null, remindedAt: null, reminderCount: 0, messageChannel: null, messageTs: null });
const rowCount = async (w: World) => (await db.select().from(cardStates).where(eq(cardStates.userId, w.studentId))).length;
const at = (iso: string) => new Date(iso);

describe('S19: the tick sends only from the student\'s local SEND_HOUR', () => {
  it('08:59 Zurich sends nothing, 09:00 sends the first card, a repeated tick sends nothing new', async () => {
    const w = await world({ start: '2026-01-06T07:59:00Z' }); // 08:59 Zurich
    expect(await runTick(w.deps, w.cfg)).toEqual({ sent: 0, resent: 0, failed: 0 });
    w.clock.set(at('2026-01-06T08:00:00Z'));
    expect(await runTick(w.deps, w.cfg)).toEqual({ sent: 1, resent: 0, failed: 0 });
    w.clock.set(at('2026-01-06T08:15:00Z'));
    expect(await runTick(w.deps, w.cfg)).toEqual({ sent: 0, resent: 0, failed: 0 }); // the card is open
    expect(w.slack.posted).toHaveLength(1);
  });

  it('a repeated tick after the day\'s work is done sends nothing (next() is empty)', async () => {
    const w = await world({ start: '2026-01-06T08:00:00Z' });
    await runTick(w.deps, w.cfg);
    const open = (await getOpenCard(db, w.studentId, w.courseId))!;
    const r = await submitAnswer(w.deps, { userId: w.studentId, flashcardId: open.flashcardId, chosenOption: 0, rating: 'medium', ...(open.messageTs && { messageTs: open.messageTs }) });
    await afterAnswer(w.deps, w.studentId, w.courseId, r);
    for (const t of ['08:15', '08:30', '12:00']) {
      w.clock.set(at(`2026-01-06T${t}:00Z`));
      expect(await runTick(w.deps, w.cfg)).toEqual({ sent: 0, resent: 0, failed: 0 });
    }
    expect(w.slack.posted).toHaveLength(1);
  });

  it('uses the student\'s own timezone: 09:00 in Auckland is 20:00Z the day before', async () => {
    const w = await world({ start: '2026-01-05T19:59:00Z', tz: 'Pacific/Auckland' });
    expect((await runTick(w.deps, w.cfg)).sent).toBe(0);
    w.clock.set(at('2026-01-05T20:00:00Z'));
    expect((await runTick(w.deps, w.cfg)).sent).toBe(1);
  });

  it('a null users.tz falls back to TENANT_TIMEZONE (UTC here)', async () => {
    const w = await world({ start: '2026-01-06T08:59:00Z', tz: null });
    expect((await runTick(w.deps, w.cfg)).sent).toBe(0);
    w.clock.set(at('2026-01-06T09:00:00Z'));
    expect((await runTick(w.deps, w.cfg)).sent).toBe(1);
  });
});

describe('local days across DST in Europe/Zurich (days are 23 and 25 hours, not +24h)', () => {
  const cases = [
    // spring forward 2026-03-29: 09:00 local is 07:00Z (CEST); the local day ends 21:59:59.999Z
    { name: '2026-03-29 (23 h)', before: '2026-03-29T06:59:00Z', at: '2026-03-29T07:00:00Z', lastDue: '2026-03-29T21:30:00Z', nextDayDue: '2026-03-29T22:30:00Z', ends: '2026-04-30T00:00:00Z' },
    // fall back 2026-10-25: 09:00 local is 08:00Z (CET); the local day ends 22:59:59.999Z
    { name: '2026-10-25 (25 h)', before: '2026-10-25T07:59:00Z', at: '2026-10-25T08:00:00Z', lastDue: '2026-10-25T22:30:00Z', nextDayDue: '2026-10-25T23:30:00Z', ends: '2026-11-30T00:00:00Z' },
  ];
  for (const c of cases) {
    it(`${c.name}: SEND_HOUR is local, and a card due at 23:30 local is due today while 00:30 tomorrow is not`, async () => {
      const w = await world({ start: c.before, endsAt: c.ends, cards: 2 });
      await seed(w, w.cardIds[0]!, reviewed(at('2026-03-01T09:00:00Z'), at(c.lastDue)));
      await seed(w, w.cardIds[1]!, reviewed(at('2026-03-01T09:00:00Z'), at(c.nextDayDue)));
      expect((await runTick(w.deps, w.cfg)).sent).toBe(0); // 08:59 local
      w.clock.set(at(c.at));
      expect((await runTick(w.deps, w.cfg)).sent).toBe(1);
      expect((await getOpenCard(db, w.studentId, w.courseId))?.flashcardId).toBe(w.cardIds[0]);
      const open = (await getOpenCard(db, w.studentId, w.courseId))!;
      const r = await submitAnswer(w.deps, { userId: w.studentId, flashcardId: open.flashcardId, chosenOption: 0, rating: 'medium' });
      await afterAnswer(w.deps, w.studentId, w.courseId, r);
      expect(await getOpenCard(db, w.studentId, w.courseId)).toBeNull(); // the 00:30 card waits for tomorrow
    });
  }
});

describe('who the tick skips', () => {
  it('a student without a Slack id: nothing sent, no card claimed', async () => {
    const w = await world({ start: '2026-01-06T08:00:00Z', slackId: null });
    expect(await runTick(w.deps, w.cfg)).toEqual({ sent: 0, resent: 0, failed: 0 });
    expect(await rowCount(w)).toBe(0);
    expect(w.slack.posted).toHaveLength(0);
  });

  it('S39 (tick part): a removed student gets no card and no re-post', async () => {
    const w = await world({ start: '2026-01-06T08:00:00Z' });
    await db.update(enrollments).set({ removedAt: at('2026-01-05T00:00:00Z') }).where(eq(enrollments.userId, w.studentId));
    expect((await runTick(w.deps, w.cfg)).sent).toBe(0);
    expect(w.slack.posted).toHaveLength(0);
  });

  it('exempt and completed students, and courses that are not active, are not touched', async () => {
    for (const status of ['exempt', 'completed']) {
      const w = await world({ start: '2026-01-06T08:00:00Z' });
      await db.update(enrollments).set({ status }).where(eq(enrollments.userId, w.studentId));
      expect(await runTick(w.deps, w.cfg)).toEqual({ sent: 0, resent: 0, failed: 0 });
    }
    const w = await world({ start: '2026-01-06T08:00:00Z' });
    await db.update(courses).set({ status: 'draft' }).where(eq(courses.id, w.courseId));
    expect((await runTick(w.deps, w.cfg)).sent).toBe(0);
  });

  it('one student\'s failure does not stop the others', async () => {
    const w = await world({ start: '2026-01-06T08:00:00Z' });
    await addStudent(w);
    w.slack.failNextPost = new Error('slack down');
    const s = await runTick(w.deps, w.cfg);
    expect(s.sent + s.failed).toBe(2);
    expect(s).toMatchObject({ sent: 1, failed: 1 });
  });
});

describe('S12: stale-claim recovery', () => {
  async function crashed() {
    const w = await world({ start: '2026-01-06T08:00:00Z' });
    w.slack.failNextPost = new Error('slack down');
    expect(await runTick(w.deps, w.cfg)).toEqual({ sent: 0, resent: 0, failed: 1 });
    const claim = (await getOpenCard(db, w.studentId, w.courseId))!;
    expect(claim.messageTs).toBeNull();
    return { w, claim };
  }

  it('a claim younger than 10 minutes is left alone, an older one is posted again once with the same sent_at and no second row', async () => {
    const { w, claim } = await crashed();
    w.clock.set(at('2026-01-06T08:09:59Z'));
    expect(await runTick(w.deps, w.cfg)).toEqual({ sent: 0, resent: 0, failed: 0 });
    w.clock.set(at('2026-01-06T08:10:00Z'));
    expect(await runTick(w.deps, w.cfg)).toEqual({ sent: 0, resent: 1, failed: 0 });
    const after = (await getOpenCard(db, w.studentId, w.courseId))!;
    expect(after.sentAt).toEqual(claim.sentAt);
    expect(after.messageTs).toBe(w.slack.posted[0]!.ts);
    expect(await rowCount(w)).toBe(1);
    w.clock.set(at('2026-01-06T08:30:00Z'));
    expect(await runTick(w.deps, w.cfg)).toEqual({ sent: 0, resent: 0, failed: 0 });
    expect(w.slack.posted).toHaveLength(1);
  });

  it('recovery is not gated by SEND_HOUR; the re-posted message is the same card', async () => {
    const w = await world({ start: '2026-01-06T05:00:00Z' }); // 06:00 Zurich
    w.slack.failNextPost = new Error('slack down');
    const { sendNext } = await import('./scheduler.js');
    await expect(sendNext(w.deps, w.studentId, w.courseId)).rejects.toThrow('slack down');
    w.clock.set(at('2026-01-06T05:10:00Z')); // 06:10, before SEND_HOUR
    expect((await runTick(w.deps, w.cfg)).resent).toBe(1);
    expect((w.slack.posted[0]!.message as CardMessage).text).toBe('Q: Q0\n1. a\n2. b');
    expect(await getCardState(db, w.studentId, w.cardIds[0]!)).toMatchObject({ messageTs: w.slack.posted[0]!.ts });
  });

  it('a card with a recorded message is never re-posted, however old', async () => {
    const w = await world({ start: '2026-01-06T08:00:00Z' });
    await runTick(w.deps, w.cfg);
    w.clock.set(at('2026-01-08T08:00:00Z'));
    expect(await runTick(w.deps, w.cfg)).toEqual({ sent: 0, resent: 0, failed: 0 });
    expect(w.slack.posted).toHaveLength(1);
  });
});

describe('stale-claim recovery: races and ended courses', () => {
  /** A Slack whose next post waits until `release()`; `entered` resolves when that post has started. */
  class GatedSlack extends FakeSlack {
    gate: Promise<void> | null = null;
    entered: () => void = () => {};
    override async postCard(to: string, message: CardMessage) {
      if (this.gate) {
        const g = this.gate;
        this.gate = null;
        this.entered();
        await g;
      }
      return super.postCard(to, message);
    }
  }

  it('a re-post that races an answer does not mark the closed card with a message', async () => {
    const slack = new GatedSlack();
    const w = await world({ start: '2026-01-06T08:00:00Z', slack });
    slack.failNextPost = new Error('slack down');
    await runTick(w.deps, w.cfg); // claimed, post failed: no message_ts
    w.clock.set(at('2026-01-06T08:10:00Z')); // stale
    let release!: () => void;
    slack.gate = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((r) => (slack.entered = r));
    const pass = runTick(w.deps, w.cfg); // the re-post is now in flight, waiting for Slack
    await entered;
    const open = (await getOpenCard(db, w.studentId, w.courseId))!;
    const r = await submitAnswer(w.deps, { userId: w.studentId, flashcardId: open.flashcardId, chosenOption: 0, rating: 'medium' });
    expect(r.status).toBe('answered'); // the delivery is closed while the post is in flight
    release();
    await pass;
    const rec = (await getCardState(db, w.studentId, w.cardIds[0]!))!;
    expect(rec).toMatchObject({ sentAt: null, messageChannel: null, messageTs: null });
  });

  it('a stale claim in a course past ends_at is not posted again (the course is still active: the finish has not run)', async () => {
    const w = await world({ start: '2000-01-05T09:00:00Z', endsAt: '2000-01-10T12:00:00Z' });
    await upsertCardState(db, {
      userId: w.studentId, flashcardId: w.cardIds[0]!, state: newCardState(at('2000-01-09T09:00:00Z')), introducedAt: at('2000-01-09T09:00:00Z'),
      sentAt: at('2000-01-09T09:00:00Z'), remindedAt: null, reminderCount: 0, messageChannel: null, messageTs: null,
    });
    w.clock.set(at('2000-01-10T13:00:00Z')); // past ends_at, finishEndedCourses has not run
    expect(await resendStaleClaim(w.deps, w.studentId, w.courseId, 10 * 60_000)).toBe(false);
    expect(w.slack.posted).toHaveLength(0);
    // runTick finishes the course first: it re-posts nothing; the only message is the course-ended DM.
    expect(await runTick(w.deps, w.cfg)).toEqual({ sent: 0, resent: 0, failed: 0 });
    expect(w.slack.posted.map((p) => p.message.text)).toEqual(['The course "C" has ended. Your final progress is 0%.']);
    expect((await getCardState(db, w.studentId, w.cardIds[0]!))?.messageTs).toBeNull();
  });
});

describe('ends_at through the tick', () => {
  it('completes the enrollment and finishes the course once', async () => {
    const w = await world({ start: '2000-01-05T09:00:00Z', endsAt: '2000-01-10T12:00:00Z' });
    w.clock.set(at('2000-01-10T12:30:00Z'));
    expect(await runTick(w.deps, w.cfg)).toEqual({ sent: 0, resent: 0, failed: 0 });
    const [c] = await db.select().from(courses).where(eq(courses.id, w.courseId));
    expect(c!.status).toBe('finished');
    const [e] = await db.select().from(enrollments).where(eq(enrollments.userId, w.studentId));
    expect(e).toMatchObject({ status: 'completed', completedProgress: 0 });
  });
});

describe('startTick', () => {
  const waitFor = async (cond: () => boolean, ms = 3000) => {
    const stop = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > stop) throw new Error('condition not reached in time');
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  it('real 20 ms interval: an overlapping interval is skipped while a pass is pending, and stop() ends the runs', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class BlockingSlack extends FakeSlack {
      override async postCard(to: string, message: CardMessage) {
        calls += 1;
        await gate;
        return super.postCard(to, message);
      }
    }
    const w = await world({ start: '2026-01-06T08:00:00Z', slack: new BlockingSlack() });
    const handle = startTick(w.deps, { ...w.cfg, intervalMs: 20 });
    try {
      await waitFor(() => handle.stats.skipped >= 3); // several intervals fired while the first pass waits for Slack
      expect(handle.stats.runs).toBe(1);
      expect(calls).toBe(1);
      release();
      await waitFor(() => handle.stats.runs >= 2); // the next interval after the pass finished runs again
    } finally {
      release();
      await handle.stop(); // waits for a pass that is running
    }
    const runs = handle.stats.runs;
    await new Promise((r) => setTimeout(r, 150));
    expect(handle.stats.runs).toBe(runs); // stop() ended the runs
    expect(calls).toBe(1); // only the first pass sent; later passes found the card open
    expect(w.slack.posted).toHaveLength(1);
  });
});
