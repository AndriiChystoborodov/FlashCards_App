import assert from 'node:assert/strict';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { createControlledClock } from '../src/clock.js';
import { env } from '../src/config/env.js';
import { getCardState, upsertCardState } from '../src/db/cardStates.js';
import { createDb } from '../src/db/client.js';
import { resetDatabase } from '../src/db/reset.js';
import * as schema from '../src/db/schema.js';
import { newCardState } from '../src/domain/calculator.js';
import { submitAnswer } from '../src/services/answer.js';

// End-to-end scenario (docs/scenario.md). Each task adds steps; a failed step stops the run.
const url = env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set.');

const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is PgTable => is(v, PgTable))
  .map((t) => getTableName(t))
  .sort();
const at = (iso: string) => new Date(iso);
const clock = createControlledClock(at('2026-01-05T09:00:00Z')); // Monday 5 January 10:00 Zurich, walkthrough section 1
const { db, pool } = createDb(url);
const deps = { db, clock, tenantTimezone: env.TENANT_TIMEZONE };

// Filled by the seed step. Cards: assessment A1 to A3 (positions 1 to 3), then card-1 and six more.
const ids = { tom: '', ann: '', bea: '', course: '', cards: [] as string[] };
const A = (n: 1 | 2 | 3) => ids.cards[n - 1]!;
const CARD1 = () => ids.cards[3]!;

/** Stands in for the scheduler's send (Task 6): opens the card at the clock's time. */
async function send(userId: string, flashcardId: string): Promise<void> {
  const existing = await getCardState(db, userId, flashcardId);
  await upsertCardState(db, {
    userId, flashcardId, state: existing?.state ?? newCardState(clock.now()), introducedAt: existing?.introducedAt ?? clock.now(),
    sentAt: clock.now(), remindedAt: null, reminderCount: 0, messageChannel: 'D1', messageTs: '1.1',
  });
}
const answered = async (userId: string, flashcardId: string, chosenOption: number | null, rating?: 'hard' | 'medium' | 'easy') => {
  const r = await submitAnswer(deps, { userId, flashcardId, chosenOption, ...(rating && { rating }) });
  assert.equal(r.status, 'answered', `expected answered, got ${JSON.stringify(r)}`);
  return r;
};
const state = async (userId: string, flashcardId: string) => (await getCardState(db, userId, flashcardId))!;
const enrollmentOf = async (userId: string) => (await db.select().from(schema.enrollments).where(eq(schema.enrollments.userId, userId)))[0]!;
const iso = (d: Date | null | undefined) => d?.toISOString();

interface Step {
  name: string;
  run: () => Promise<void>;
}

const steps: Step[] = [
  { name: 'reset: database rebuilt and migrated', run: () => resetDatabase(url) },
  {
    name: 'schema: every schema table exists and is empty',
    run: async () => {
      const { pool } = createDb(url);
      try {
        const tables = await pool.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
        );
        assert.deepEqual(tables.rows.map((r) => r.table_name).sort(), TABLES); // both sorted in JS, so database collation does not matter
        for (const t of TABLES) {
          const n = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}"`);
          assert.equal(n.rows[0]?.n, 0, `table ${t} is not empty`);
        }
      } finally {
        await pool.end();
      }
    },
  },
  {
    name: 'clock: advances by days',
    run: async () => {
      clock.advanceDays(2);
      assert.equal(iso(clock.now()), '2026-01-07T09:00:00.000Z');
      clock.set(at('2026-01-05T09:00:00Z'));
    },
  },
  {
    name: 'section 1 (seeded directly, REST and MCP come later): active course, 10 cards, Ann and Bea enrolled',
    run: async () => {
      const [tom, ann, bea] = await db.insert(schema.users).values([
        { fullName: 'Tom', email: 'tom@x.test', role: 'teacher' },
        { fullName: 'Ann', email: 'ann@x.test', role: 'student', tz: 'Europe/Zurich' },
        { fullName: 'Bea', email: 'bea@x.test', role: 'student', tz: 'Europe/Zurich' },
      ]).returning();
      const [course] = await db.insert(schema.courses).values({
        teacherId: tom!.id, title: 'Security basics', materialUrl: 'https://wiki.example.com/security-policy', status: 'active',
        assessmentPassThreshold: 90, startsAt: clock.now(), endsAt: at('2026-01-16T22:59:00Z'), // Friday 16 January 23:59 Zurich
      }).returning();
      const cards = await db.insert(schema.flashcards).values(
        Array.from({ length: 10 }, (_, i) => ({
          courseId: course!.id, question: `Q${i + 1}`, options: ['right', 'x', 'y'], correctOption: 0, isAssessment: i < 3, position: i + 1,
        })),
      ).returning();
      await db.insert(schema.enrollments).values([ann!, bea!].map((u) => ({ courseId: course!.id, userId: u.id, status: 'active', enrolledAt: clock.now() })));
      Object.assign(ids, { tom: tom!.id, ann: ann!.id, bea: bea!.id, course: course!.id, cards: cards.sort((a, b) => a.position - b.position).map((c) => c.id) });
      assert.equal(cards.filter((c) => c.isAssessment).length, 3);
      assert.equal((await enrollmentOf(ids.ann)).status, 'active');
      assert.equal((await enrollmentOf(ids.ann)).assessmentDoneAt, null);
    },
  },
  {
    name: 'section 2: A1 right + Easy at 14:00; review stored, nothing evaluated yet',
    run: async () => {
      await send(ids.ann, A(1));
      clock.set(at('2026-01-05T13:00:00Z'));
      const r = await answered(ids.ann, A(1), 0, 'easy');
      assert.equal(r.review.rating, 'easy');
      assert.equal(r.assessment, null);
      const s = await state(ids.ann, A(1));
      assert.equal(s.sentAt, null);
      assert.equal(s.state.scheduled_days, 8);
      assert.equal(s.state.correctStreak, 1);
      assert.equal((await enrollmentOf(ids.ann)).assessmentDoneAt, null);
    },
  },
  {
    name: 'section 2: A2 right + Medium at 14:03: due in 2 days, streak 1',
    run: async () => {
      clock.set(at('2026-01-05T13:03:00Z'));
      await send(ids.ann, A(2));
      await answered(ids.ann, A(2), 0, 'medium');
      const s = (await state(ids.ann, A(2))).state;
      assert.equal(s.scheduled_days, 2);
      assert.equal(s.correctStreak, 1);
      assert.equal(iso(s.due), '2026-01-07T13:03:00.000Z');
    },
  },
  {
    name: 'section 2: A3 "Don\'t know" at 14:05 is the last assessment card: 33%, not exempt, only A1 learned',
    run: async () => {
      clock.set(at('2026-01-05T13:05:00Z'));
      await send(ids.ann, A(3));
      const r = await answered(ids.ann, A(3), null);
      assert.equal(r.assessment?.exempt, false);
      assert.deepEqual(r.assessment?.learnedFlashcardIds, [A(1)]);
      const e = await enrollmentOf(ids.ann);
      assert.equal(iso(e.assessmentDoneAt), '2026-01-05T13:05:00.000Z');
      assert.equal(Math.round((e.assessmentScore ?? 0) * 100) / 100, 33.33);
      assert.equal(e.status, 'active');
      assert.equal(iso((await state(ids.ann, A(1))).state.learnedAt), '2026-01-05T13:05:00.000Z');
      assert.equal((await state(ids.ann, A(2))).state.learnedAt, null);
      const a3 = (await state(ids.ann, A(3))).state;
      assert.equal(a3.learnedAt, null);
      assert.equal(a3.scheduled_days, 1);
      assert.equal(Math.round(a3.stability * 100) / 100, 0.21);
      assert.equal(iso(a3.due), '2026-01-06T13:05:00.000Z');
    },
  },
  {
    name: 'section 6: a second click on A3 is refused (not open); still one review, assessment not evaluated again',
    run: async () => {
      const r = await submitAnswer(deps, { userId: ids.ann, flashcardId: A(3), chosenOption: 0, rating: 'easy' });
      assert.deepEqual(r, { status: 'rejected', reason: 'not_open' });
      const rows = await db.select().from(schema.reviews).where(eq(schema.reviews.flashcardId, A(3)));
      assert.equal(rows.length, 1);
      assert.equal(iso((await enrollmentOf(ids.ann)).assessmentDoneAt), '2026-01-05T13:05:00.000Z');
    },
  },
  {
    name: 'section 2: Bea answers all three right + Easy: exempt, 100%, nothing left open',
    run: async () => {
      for (const n of [1, 2, 3] as const) {
        await send(ids.bea, A(n));
        await answered(ids.bea, A(n), 0, 'easy');
      }
      const e = await enrollmentOf(ids.bea);
      assert.equal(e.status, 'exempt');
      assert.equal(e.assessmentScore, 100);
      assert.equal(iso(e.assessmentDoneAt), '2026-01-05T13:05:00.000Z');
      const open = await db.select().from(schema.cardStates).where(eq(schema.cardStates.userId, ids.bea));
      assert.ok(open.every((r) => r.sentAt === null));
    },
  },
  {
    name: 'section 3 (answer part): card-1 Monday Medium: due Wednesday 14:06, streak 1',
    run: async () => {
      clock.set(at('2026-01-05T13:06:00Z'));
      await send(ids.ann, CARD1());
      await answered(ids.ann, CARD1(), 0, 'medium');
      const s = (await state(ids.ann, CARD1())).state;
      assert.equal(s.scheduled_days, 2);
      assert.equal(s.correctStreak, 1);
      assert.equal(iso(s.due), '2026-01-07T13:06:00.000Z');
    },
  },
  {
    name: 'section 3 (answer part): card-1 Wednesday 09:15 Medium: FSRS due Sunday 18 January is clamped to the end of Thursday, not learned',
    run: async () => {
      clock.set(at('2026-01-07T08:15:00Z'));
      await send(ids.ann, CARD1());
      const r = await answered(ids.ann, CARD1(), 0, 'medium');
      assert.equal(iso(r.clampedFrom), '2026-01-18T08:15:00.000Z');
      const s = (await state(ids.ann, CARD1())).state;
      assert.equal(s.scheduled_days, 11);
      assert.equal(s.correctStreak, 2);
      assert.equal(iso(s.due), '2026-01-15T22:59:59.999Z');
      assert.equal(s.learnedAt, null);
    },
  },
  {
    name: 'section 3 (answer part): card-1 Thursday 15 January 09:20 Medium: gap 8 days, learned',
    run: async () => {
      clock.set(at('2026-01-15T08:20:00Z'));
      await send(ids.ann, CARD1());
      const r = await answered(ids.ann, CARD1(), 0, 'medium');
      assert.equal(iso(r.state.learnedAt), '2026-01-15T08:20:00.000Z');
      assert.equal(r.state.correctStreak, 3);
      assert.equal(iso((await state(ids.ann, CARD1())).state.learnedAt), '2026-01-15T08:20:00.000Z');
    },
  },
];

// Walkthrough sections that need later tasks (docs/scenario.md). Listed, not run.
const pending = [
  '1 teacher sets up (create_course, add_flashcards, enroll_students, start_course): Tasks 7, 9',
  '3 normal mode: the daily tick, quota, next card after an answer, completion (answer and clamp steps above run now): Task 6',
  '4 progress: Task 7',
  '5 stop_course: Task 7',
  '6 edge cases (reminders, added card; the second click is checked above): Task 6',
];

for (const [i, step] of steps.entries()) {
  try {
    await step.run();
    console.log(`ok   ${i + 1} ${step.name}`);
  } catch (err) {
    console.error(`FAIL ${i + 1} ${step.name}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`${i} ok, failed at step ${i + 1} of ${steps.length}, ${pending.length} pending not run`);
    process.exit(1);
  }
}
for (const p of pending) console.log(`pending ${p}`);
console.log(`${steps.length} ok, ${pending.length} pending`);
await pool.end();
