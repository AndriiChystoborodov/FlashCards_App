import assert from 'node:assert/strict';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { createControlledClock } from '../src/clock.js';
import { env } from '../src/config/env.js';
import { getCardState } from '../src/db/cardStates.js';
import { getOpenCard } from '../src/db/selection.js';
import { createDb } from '../src/db/client.js';
import { resetDatabase } from '../src/db/reset.js';
import * as schema from '../src/db/schema.js';
import { submitAnswer } from '../src/services/answer.js';
import { afterAnswer, finishEndedCourses, sendFirstCards, sendNext, TEXT } from '../src/services/scheduler.js';
import { FakeSlack } from '../src/slack/fake.js';

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
const slack = new FakeSlack();
const deps = { db, clock, tenantTimezone: env.TENANT_TIMEZONE, slack };

// Filled by the seed step. Cards: assessment A1 to A3 (positions 1 to 3), then card-1 and six more.
const ids = { tom: '', ann: '', bea: '', course: '', cards: [] as string[] };
const A = (n: 1 | 2 | 3) => ids.cards[n - 1]!;
const CARD = (n: number) => ids.cards[n + 2]!; // card-1 is position 4
const nameOf = (id: string) => {
  const i = ids.cards.indexOf(id);
  return i < 3 ? `A${i + 1}` : `card-${i - 2}`;
};

const state = async (userId: string, flashcardId: string) => (await getCardState(db, userId, flashcardId))!;
const enrollmentOf = async (userId: string) => (await db.select().from(schema.enrollments).where(eq(schema.enrollments.userId, userId)))[0]!;
const iso = (d: Date | null | undefined) => d?.toISOString();

/** The student answers the open card the way a click would (with its message ts); then the scheduler sends what follows. */
async function reply(userId: string, chosenOption: number | null, rating?: 'hard' | 'medium' | 'easy') {
  const open = await getOpenCard(db, userId, ids.course);
  assert.ok(open, 'the student has no open card');
  const result = await submitAnswer(deps, { userId, flashcardId: open.flashcardId, chosenOption, ...(rating && { rating }), ...(open.messageTs && { messageTs: open.messageTs }) });
  assert.equal(result.status, 'answered', `expected answered, got ${JSON.stringify(result)}`);
  const sent = await afterAnswer(deps, userId, ids.course, result);
  return { id: open.flashcardId, result, sent };
}
const sentName = (s: Awaited<ReturnType<typeof reply>>['sent']) => (s.status === 'sent' ? nameOf(s.flashcardId) : 'none');

/** A student's morning at 09:00 Zurich (08:00Z): the tick's send (Task 6 sends it directly), then Medium on every card until none is left. */
async function studentDay(userId: string, date: string) {
  clock.set(at(`${date}T08:00:00Z`));
  const log: { card: string; kind: string }[] = [];
  let sent = await sendNext(deps, userId, ids.course);
  for (let n = 0; sent.status === 'sent'; n++) {
    assert.ok(n < 20, `more than 20 cards in one morning on ${date}`);
    log.push({ card: nameOf(sent.flashcardId), kind: sent.kind });
    clock.set(new Date(clock.now().getTime() + 5 * 60_000));
    sent = (await reply(userId, 0, 'medium')).sent;
  }
  return log;
}

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
        { fullName: 'Ann', email: 'ann@x.test', role: 'student', tz: 'Europe/Zurich', slackId: 'UANN' },
        { fullName: 'Bea', email: 'bea@x.test', role: 'student', tz: 'Europe/Zurich', slackId: 'UBEA' },
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
    name: 'section 1: start_course sends the first assessment card (A1) to Ann and Bea at once',
    run: async () => {
      assert.equal(await sendFirstCards(deps, ids.course), 2);
      assert.equal(slack.posted.length, 2);
      for (const u of [ids.ann, ids.bea]) assert.equal((await getOpenCard(db, u, ids.course))?.flashcardId, A(1));
      assert.match(slack.posted[0]!.message.text, /^Q: Q1\n1\. right/);
      assert.equal(await sendFirstCards(deps, ids.course), 0); // repeating sends nothing: the cards are open
    },
  },
  {
    name: 'section 2: A1 right + Easy at 14:00; review stored, A2 follows at once, nothing evaluated yet',
    run: async () => {
      clock.set(at('2026-01-05T13:00:00Z'));
      const r = await reply(ids.ann, 0, 'easy');
      assert.equal(r.result.status === 'answered' && r.result.review.rating, 'easy');
      assert.equal(r.result.status === 'answered' && r.result.assessment, null);
      const s = await state(ids.ann, A(1));
      assert.equal(s.sentAt, null);
      assert.equal(s.state.scheduled_days, 8);
      assert.equal(s.state.correctStreak, 1);
      assert.equal(sentName(r.sent), 'A2');
      assert.equal((await enrollmentOf(ids.ann)).assessmentDoneAt, null);
    },
  },
  {
    name: 'section 2: A2 right + Medium at 14:03: due in 2 days, streak 1, A3 follows',
    run: async () => {
      clock.set(at('2026-01-05T13:03:00Z'));
      const r = await reply(ids.ann, 0, 'medium');
      const s = (await state(ids.ann, A(2))).state;
      assert.equal(s.scheduled_days, 2);
      assert.equal(s.correctStreak, 1);
      assert.equal(iso(s.due), '2026-01-07T13:03:00.000Z');
      assert.equal(sentName(r.sent), 'A3');
    },
  },
  {
    name: 'section 2: A3 "Don\'t know" at 14:05 is the last assessment card: 33%, not exempt, only A1 learned, card-1 follows (new, quota 1)',
    run: async () => {
      clock.set(at('2026-01-05T13:05:00Z'));
      const r = await reply(ids.ann, null);
      assert.equal(r.result.status === 'answered' && r.result.assessment?.exempt, false);
      assert.deepEqual(r.result.status === 'answered' && r.result.assessment?.learnedFlashcardIds, [A(1)]);
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
      // Section 3, Monday: 7 non-assessment cards remain, 12 local days left, introducedToday 0 (assessment cards do not count): quota 1.
      assert.deepEqual(r.sent.status === 'sent' && [r.sent.kind, nameOf(r.sent.flashcardId)], ['new', 'card-1']);
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
    name: 'section 2: Bea answers all three right + Easy: exempt, 100%, the "already know" message, no card left open',
    run: async () => {
      for (const _ of [1, 2, 3]) await reply(ids.bea, 0, 'easy');
      const e = await enrollmentOf(ids.bea);
      assert.equal(e.status, 'exempt');
      assert.equal(e.assessmentScore, 100);
      assert.equal(iso(e.assessmentDoneAt), '2026-01-05T13:05:00.000Z');
      assert.equal(await getOpenCard(db, ids.bea, ids.course), null);
      assert.equal(slack.posted.at(-1)?.message.text, TEXT.exempt);
      assert.deepEqual(await sendNext(deps, ids.bea, ids.course), { status: 'none' });
    },
  },
  {
    name: 'section 3: card-1 Monday 14:06 Medium: due Wednesday 14:06, streak 1; no second new card today (quota used)',
    run: async () => {
      clock.set(at('2026-01-05T13:06:00Z'));
      const r = await reply(ids.ann, 0, 'medium');
      const s = (await state(ids.ann, CARD(1))).state;
      assert.equal(s.scheduled_days, 2);
      assert.equal(s.correctStreak, 1);
      assert.equal(iso(s.due), '2026-01-07T13:06:00.000Z');
      assert.equal(sentName(r.sent), 'none');
    },
  },
  {
    name: 'section 3: Tuesday 09:00: A3 (due Tuesday 14:05) is sent first, then card-2 is introduced (quota 1); Ann answers both',
    run: async () => {
      clock.set(at('2026-01-06T08:00:00Z'));
      const first = await sendNext(deps, ids.ann, ids.course);
      assert.deepEqual(first.status === 'sent' && [first.kind, nameOf(first.flashcardId)], ['due', 'A3']);
      clock.set(at('2026-01-06T08:05:00Z'));
      const a3 = await reply(ids.ann, 0, 'medium');
      const s = (await state(ids.ann, A(3))).state;
      assert.equal(s.scheduled_days, 2);
      assert.equal(Math.round(s.stability * 100) / 100, 1.89);
      assert.equal(s.correctStreak, 1);
      assert.deepEqual(a3.sent.status === 'sent' && [a3.sent.kind, nameOf(a3.sent.flashcardId)], ['new', 'card-2']);
      clock.set(at('2026-01-06T08:10:00Z'));
      assert.equal(sentName((await reply(ids.ann, 0, 'medium')).sent), 'none'); // introducedToday 1, quota 1
    },
  },
  {
    name: 'section 3: Wednesday 09:00: A2 (due 14:03) before card-1 (due 14:06), then card-3; card-1 at 09:15 is clamped to the end of Thursday, not learned',
    run: async () => {
      clock.set(at('2026-01-07T08:00:00Z'));
      const first = await sendNext(deps, ids.ann, ids.course);
      assert.deepEqual(first.status === 'sent' && [first.kind, nameOf(first.flashcardId)], ['due', 'A2']);
      clock.set(at('2026-01-07T08:05:00Z'));
      const a2 = await reply(ids.ann, 0, 'medium');
      assert.equal(sentName(a2.sent), 'card-1');
      clock.set(at('2026-01-07T08:15:00Z'));
      const c1 = await reply(ids.ann, 0, 'medium');
      assert.equal(c1.result.status === 'answered' && iso(c1.result.clampedFrom), '2026-01-18T08:15:00.000Z');
      const s = (await state(ids.ann, CARD(1))).state;
      assert.equal(s.scheduled_days, 11);
      assert.equal(s.correctStreak, 2);
      assert.equal(iso(s.due), '2026-01-15T22:59:59.999Z');
      assert.equal(s.learnedAt, null);
      assert.equal(sentName(c1.sent), 'card-3'); // the day's new card
      clock.set(at('2026-01-07T08:20:00Z'));
      assert.equal(sentName((await reply(ids.ann, 0, 'medium')).sent), 'none');
    },
  },
  {
    name: 'section 3: Thursday 8 to Sunday 11 January: one new card per day until all 7 are introduced',
    run: async () => {
      const introduced: string[] = [];
      for (const d of ['2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11']) {
        const log = await studentDay(ids.ann, d);
        const fresh = log.filter((l) => l.kind === 'new').map((l) => l.card);
        assert.equal(fresh.length, 1, `${d}: expected one new card, got ${JSON.stringify(log)}`);
        introduced.push(...fresh);
      }
      assert.deepEqual(introduced, ['card-4', 'card-5', 'card-6', 'card-7']);
      const rows = await db.select().from(schema.cardStates).where(eq(schema.cardStates.userId, ids.ann));
      assert.equal(rows.length, 10); // all cards introduced by Sunday 11 January
    },
  },
  {
    name: 'section 3: Monday 12 to Wednesday 14 January: reviews only, no new cards, nothing asked twice in a day',
    run: async () => {
      for (const d of ['2026-01-12', '2026-01-13', '2026-01-14']) {
        const log = await studentDay(ids.ann, d);
        assert.ok(log.every((l) => l.kind === 'due'), `${d}: ${JSON.stringify(log)}`);
        assert.equal(new Set(log.map((l) => l.card)).size, log.length, `${d}: a card was asked twice: ${JSON.stringify(log)}`);
      }
    },
  },
  {
    name: 'section 3: Thursday 15 January: card-1 is asked again, gap 8 days, learned; no card is asked twice on the last review day (clamp fix)',
    run: async () => {
      const log = await studentDay(ids.ann, '2026-01-15');
      assert.ok(log.some((l) => l.card === 'card-1'), JSON.stringify(log));
      assert.equal(new Set(log.map((l) => l.card)).size, log.length, `a card was asked twice: ${JSON.stringify(log)}`);
      const s = (await state(ids.ann, CARD(1))).state;
      assert.equal(s.correctStreak, 3);
      assert.match(iso(s.learnedAt) ?? '', /^2026-01-15T/);
    },
  },
  {
    name: 'section 3: Friday 16 January: nothing is due any more',
    run: async () => {
      assert.deepEqual(await studentDay(ids.ann, '2026-01-16'), []);
    },
  },
  {
    name: 'section 3: after ends_at: the course is finished, Ann is completed with her real progress, Bea stays exempt, nothing more is sent',
    run: async () => {
      clock.set(at('2026-01-16T23:00:00Z')); // ends_at was 22:59
      assert.deepEqual(await finishEndedCourses(deps), [ids.course]);
      const learned = (await db.select().from(schema.cardStates).where(eq(schema.cardStates.userId, ids.ann))).filter((r) => r.learnedAt).length;
      const ann = await enrollmentOf(ids.ann);
      assert.equal(ann.status, 'completed');
      assert.equal(ann.completedProgress, learned * 10);
      console.log(`     (real scenario outcome: Ann learned ${learned} of 10, completed_progress ${ann.completedProgress})`);
      assert.equal((await enrollmentOf(ids.bea)).status, 'exempt');
      assert.equal(slack.posted.at(-1)?.message.text, TEXT.ended(ann.completedProgress ?? 0));
      const [c] = await db.select().from(schema.courses).where(eq(schema.courses.id, ids.course));
      assert.equal(c!.status, 'finished');
      assert.deepEqual(await sendNext(deps, ids.ann, ids.course), { status: 'none' });
      assert.deepEqual(await finishEndedCourses(deps), []);
    },
  },
];

// Walkthrough sections that need later tasks (docs/scenario.md). Listed, not run.
const pending = [
  '1 teacher sets up (create_course, add_flashcards, enroll_students, start_course): Tasks 7, 9',
  '3 normal mode driven by the daily tick at SEND_HOUR (the steps above send directly): Task 6b-1',
  '4 progress: Task 7',
  '5 stop_course: Task 7',
  '6 edge cases (reminders, stale claims, removal and cleanup; the second click is checked above): Task 6b-2',
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
