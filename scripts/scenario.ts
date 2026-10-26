import assert from 'node:assert/strict';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/api/app.js';
import { listen, type Api } from '../src/api/testClient.js';
import { createControlledClock } from '../src/clock.js';
import { env } from '../src/config/env.js';
import { getCardState } from '../src/db/cardStates.js';
import { getOpenCard } from '../src/db/selection.js';
import { createDb } from '../src/db/client.js';
import { resetDatabase } from '../src/db/reset.js';
import * as schema from '../src/db/schema.js';
import { submitAnswer } from '../src/services/answer.js';
import { issueTeacherToken } from '../src/services/auth.js';
import { afterAnswer, sendNext, TEXT } from '../src/services/scheduler.js';
import { runTick } from '../src/services/tick.js';
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
// The REST API runs in this process on 127.0.0.1 and a random port; Tom's token comes from the same function as `npm run teacher:token`.
slack.directory.set('ann@x.test', { slackId: 'UANN', tz: 'Europe/Zurich' });
slack.directory.set('bea@x.test', { slackId: 'UBEA', tz: 'Europe/Zurich' });
let api!: Api;
let tomToken = '';
const rest = async (method: string, path: string, body?: unknown, expected = 200) => {
  const r = await api.call(tomToken, method, path, body);
  assert.equal(r.status, expected, `${method} ${path}: expected ${expected}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

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

const TICK = { sendHour: 9 };

/** Ann answers Medium on every open card, five minutes apart, until none is left (a card sent by the tick or by the answer before). */
async function answerAll(userId: string) {
  const log: { card: string; kind: string }[] = [];
  for (let n = 0; ; n++) {
    const open = await getOpenCard(db, userId, ids.course);
    if (!open) return log;
    assert.ok(n < 20, 'more than 20 cards in one morning');
    const st = await state(userId, open.flashcardId);
    log.push({ card: nameOf(open.flashcardId), kind: st.introducedAt.getTime() === st.sentAt?.getTime() ? 'new' : 'due' });
    clock.set(new Date(clock.now().getTime() + 5 * 60_000));
    await reply(userId, 0, 'medium');
  }
}

/** A day of Ann's: the tick at 09:00 Zurich (08:00Z), then her Medium answers. The tick sends the first card, the answers send the rest. */
async function tickDay(date: string) {
  clock.set(at(`${date}T08:00:00Z`));
  const t = await runTick(deps, TICK);
  assert.equal(t.failed, 0);
  return answerAll(ids.ann);
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
    name: 'section 1 (REST): Tom creates the course, adds 10 cards (3 assessment), enrolls Ann and Bea; a draft course sends nothing',
    run: async () => {
      tomToken = await issueTeacherToken(db, { email: 'tom@x.test', fullName: 'Tom' });
      api = await listen(createApp({ ...deps, removedRetentionDays: env.REMOVED_RETENTION_DAYS, studentRoutesEnabled: false }));
      assert.equal((await api.call(null, 'GET', '/courses')).status, 401);
      assert.equal((await api.call('x'.repeat(43), 'GET', '/courses')).status, 401);
      const course = await rest('POST', '/courses', { title: 'Security basics', material_url: 'https://wiki.example.com/security-policy', ends_at: '2026-01-16T22:59:00Z' }, 201); // Friday 23:59 Zurich
      assert.equal(course.status, 'draft');
      assert.equal(course.assessment_pass_threshold, 90);
      const added = await rest('POST', `/courses/${course.course_id}/flashcards`, {
        flashcards: Array.from({ length: 10 }, (_, i) => ({ question: `Q${i + 1}`, options: ['right', 'x', 'y'], correct_option: 0, is_assessment: i < 3 })),
      }, 201);
      assert.deepEqual(added.flashcards.map((f: { position: number }) => f.position), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const enrolled = await rest('POST', `/courses/${course.course_id}/students`, { students: [{ email: 'ann@x.test', name: 'Ann' }, { email: 'bea@x.test', name: 'Bea' }] });
      assert.deepEqual(enrolled.students.map((s: { enrolled: boolean; slack_matched: boolean }) => [s.enrolled, s.slack_matched]), [[true, true], [true, true]]);
      const shown = await rest('GET', `/courses/${course.course_id}`);
      assert.deepEqual([shown.status, shown.card_count, shown.assessment_card_count, shown.student_count], ['draft', 10, 3, 2]);
      assert.equal(slack.posted.length, 0);
      const students = await rest('GET', `/courses/${course.course_id}/students`);
      const idByEmail = Object.fromEntries(students.students.map((s: { email: string; student_id: string }) => [s.email, s.student_id]));
      const [tom] = await db.select().from(schema.users).where(eq(schema.users.email, 'tom@x.test'));
      Object.assign(ids, { tom: tom!.id, ann: idByEmail['ann@x.test'], bea: idByEmail['bea@x.test'], course: course.course_id, cards: added.flashcards.map((f: { flashcard_id: string }) => f.flashcard_id) });
      assert.equal((await enrollmentOf(ids.ann)).status, 'active');
      assert.equal((await enrollmentOf(ids.ann)).assessmentDoneAt, null);
    },
  },
  {
    name: 'section 1 (REST): start_course sends the start message and the first assessment card (A1) to Ann and Bea at once; a second start is refused',
    run: async () => {
      const started = await rest('POST', `/courses/${ids.course}/start`);
      assert.equal(started.status, 'active');
      assert.equal(started.starts_at, '2026-01-05T09:00:00.000Z');
      assert.equal(slack.posted.length, 4); // the start message, then A1, for each student
      assert.deepEqual(slack.posted.slice(0, 2).map((p) => p.message.text), [TEXT.started, TEXT.started]);
      for (const u of [ids.ann, ids.bea]) assert.equal((await getOpenCard(db, u, ids.course))?.flashcardId, A(1));
      assert.match(slack.posted[2]!.message.text, /^Q: Q1\n1\. right/);
      const again = await api.call(tomToken, 'POST', `/courses/${ids.course}/start`);
      assert.deepEqual([again.status, again.body.error.code], [409, 'course_not_draft']);
      assert.equal(slack.posted.length, 4); // repeating sends nothing: the cards are open
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
    name: 'S19: Tuesday 08:59 Zurich: the tick sends nothing yet (SEND_HOUR 9)',
    run: async () => {
      clock.set(at('2026-01-06T07:59:00Z'));
      assert.deepEqual(await runTick(deps, TICK), { sent: 0, resent: 0, failed: 0 });
      assert.equal(await getOpenCard(db, ids.ann, ids.course), null);
    },
  },
  {
    name: 'section 3: Tuesday 09:00 tick: A3 (due Tuesday 14:05) is sent first (Bea, exempt, gets nothing), then card-2 is introduced (quota 1); Ann answers both',
    run: async () => {
      clock.set(at('2026-01-06T08:00:00Z'));
      assert.deepEqual(await runTick(deps, TICK), { sent: 1, resent: 0, failed: 0 });
      assert.equal((await getOpenCard(db, ids.ann, ids.course))?.flashcardId, A(3));
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
    name: 'section 3: Wednesday 09:00 tick: A2 (due 14:03) before card-1 (due 14:06), then card-3; card-1 at 09:15 is clamped to the end of Thursday, not learned',
    run: async () => {
      clock.set(at('2026-01-07T08:00:00Z'));
      assert.deepEqual(await runTick(deps, TICK), { sent: 1, resent: 0, failed: 0 });
      assert.equal((await getOpenCard(db, ids.ann, ids.course))?.flashcardId, A(2));
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
    name: 'S12: Thursday 8 January 09:00 tick: Slack fails after the claim; 5 minutes later nothing; at 10 minutes the same delivery is posted again',
    run: async () => {
      clock.set(at('2026-01-08T08:00:00Z'));
      slack.failNextPost = new Error('slack down');
      assert.deepEqual(await runTick(deps, TICK), { sent: 0, resent: 0, failed: 1 });
      const claim = await getOpenCard(db, ids.ann, ids.course);
      assert.ok(claim && claim.messageTs === null, 'the card is claimed without a message');
      const posts = slack.posted.length;
      clock.set(at('2026-01-08T08:05:00Z'));
      assert.deepEqual(await runTick(deps, TICK), { sent: 0, resent: 0, failed: 0 });
      assert.equal(slack.posted.length, posts);
      clock.set(at('2026-01-08T08:10:00Z'));
      assert.deepEqual(await runTick(deps, TICK), { sent: 0, resent: 1, failed: 0 });
      const after = await getOpenCard(db, ids.ann, ids.course);
      assert.equal(after?.sentAt?.getTime(), claim.sentAt?.getTime());
      assert.equal(after?.messageTs, slack.posted.at(-1)?.ts);
      assert.equal(slack.posted.length, posts + 1);
    },
  },
  {
    name: 'section 3: Thursday 8 to Sunday 11 January: one new card per day until all 7 are introduced (Thursday continues after the recovery)',
    run: async () => {
      const introduced: string[] = [];
      let log = await answerAll(ids.ann); // Thursday: the recovered card and what follows
      for (const d of ['2026-01-09', '2026-01-10', '2026-01-11', null]) {
        const fresh = log.filter((l) => l.kind === 'new').map((l) => l.card);
        assert.equal(fresh.length, 1, `expected one new card, got ${JSON.stringify(log)}`);
        introduced.push(...fresh);
        if (d) log = await tickDay(d);
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
        const log = await tickDay(d);
        assert.ok(log.every((l) => l.kind === 'due'), `${d}: ${JSON.stringify(log)}`);
        assert.equal(new Set(log.map((l) => l.card)).size, log.length, `${d}: a card was asked twice: ${JSON.stringify(log)}`);
      }
    },
  },
  {
    name: 'section 3: Thursday 15 January: card-1 is asked again, gap 8 days, learned; no card is asked twice on the last review day (clamp fix)',
    run: async () => {
      const log = await tickDay('2026-01-15');
      assert.ok(log.some((l) => l.card === 'card-1'), JSON.stringify(log));
      assert.equal(new Set(log.map((l) => l.card)).size, log.length, `a card was asked twice: ${JSON.stringify(log)}`);
      const s = (await state(ids.ann, CARD(1))).state;
      assert.equal(s.correctStreak, 3);
      assert.match(iso(s.learnedAt) ?? '', /^2026-01-15T/);
    },
  },
  {
    name: 'section 4 (REST): progress after Thursday 15 January: Ann learned/total, Bea exempt at 100, class average, per-card list, nobody waiting',
    run: async () => {
      const learned = (await db.select().from(schema.cardStates).where(eq(schema.cardStates.userId, ids.ann))).filter((r) => r.learnedAt).length;
      assert.ok(learned >= 2, `Ann has learned ${learned} cards`); // A1 and card-1 at least
      const p = await rest('GET', `/courses/${ids.course}/progress`);
      const byId = Object.fromEntries(p.students.map((s: { student_id: string }) => [s.student_id, s]));
      assert.deepEqual([byId[ids.ann].status, byId[ids.ann].learned, byId[ids.ann].total, byId[ids.ann].progress, byId[ids.ann].assessment_done, byId[ids.ann].waiting_since], ['active', learned, 10, learned * 10, true, null]);
      assert.deepEqual([byId[ids.bea].status, byId[ids.bea].progress, byId[ids.bea].assessment_done], ['exempt', 100, true]);
      assert.equal(p.class_progress, (learned * 10 + 100) / 2);
      const one = await rest('GET', `/courses/${ids.course}/students/${ids.ann}/progress`);
      assert.equal(one.cards.length, 10);
      assert.equal(one.cards.filter((c: { learned: boolean }) => c.learned).length, learned);
      const card1 = one.cards.find((c: { flashcard_id: string }) => c.flashcard_id === CARD(1));
      assert.deepEqual([card1.learned, card1.correct_streak, card1.last_answer_correct], [true, 3, true]);
      console.log(`     (class progress ${p.class_progress}: Ann ${learned} of 10, Bea exempt)`);
    },
  },
  {
    name: 'section 3: Friday 16 January: nothing is due any more',
    run: async () => {
      assert.deepEqual(await tickDay('2026-01-16'), []);
    },
  },
  {
    name: 'section 3: tick after ends_at: the course is finished, Ann is completed with her real progress, Bea stays exempt, nothing more is sent',
    run: async () => {
      clock.set(at('2026-01-16T23:00:00Z')); // ends_at was 22:59
      assert.deepEqual(await runTick(deps, TICK), { sent: 0, resent: 0, failed: 0 });
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
      assert.deepEqual(await runTick(deps, TICK), { sent: 0, resent: 0, failed: 0 }); // finished once, nothing left to do
    },
  },
  {
    name: 'section 5 and 6 (REST): in a second course Tom removes Dee (open card replaced with "expired", idempotent) and stops the course (Cy completed, 0%, ended message)',
    run: async () => {
      slack.directory.set('cy@x.test', { slackId: 'UCY', tz: 'Europe/Zurich' });
      slack.directory.set('dee@x.test', { slackId: 'UDEE', tz: 'Europe/Zurich' });
      clock.set(at('2026-01-17T09:00:00Z'));
      const c = await rest('POST', '/courses', { title: 'Phishing', material_url: 'https://wiki.example.com/phishing', ends_at: '2026-02-01T00:00:00Z' }, 201);
      await rest('POST', `/courses/${c.course_id}/flashcards`, { flashcards: [{ question: 'P1', options: ['right', 'x'], correct_option: 0, is_assessment: true }, { question: 'P2', options: ['right', 'x'], correct_option: 0, is_assessment: false }] }, 201);
      await rest('POST', `/courses/${c.course_id}/students`, { students: [{ email: 'cy@x.test', name: 'Cy' }, { email: 'dee@x.test', name: 'Dee' }] });
      await rest('POST', `/courses/${c.course_id}/start`);
      const list = (await rest('GET', `/courses/${c.course_id}/students`)).students as { student_id: string; email: string }[];
      const cy = list.find((s) => s.email === 'cy@x.test')!.student_id;
      const dee = list.find((s) => s.email === 'dee@x.test')!.student_id;
      const deeCard = await getOpenCard(db, dee, c.course_id);
      assert.ok(deeCard?.messageTs);

      await rest('DELETE', `/courses/${c.course_id}/students/${dee}`, undefined, 204);
      assert.equal(slack.replaced.at(-1)?.message.text, TEXT.removed);
      assert.equal(slack.replaced.at(-1)?.ts, deeCard.messageTs);
      assert.equal(await getOpenCard(db, dee, c.course_id), null);
      const replaced = slack.replaced.length;
      await rest('DELETE', `/courses/${c.course_id}/students/${dee}`, undefined, 204);
      assert.equal(slack.replaced.length, replaced);
      assert.equal((await rest('GET', `/courses/${c.course_id}`)).student_count, 1);
      assert.deepEqual((await rest('GET', `/courses/${c.course_id}/progress`)).students.map((s: { student_id: string }) => s.student_id), [cy]);

      const cyCard = await getOpenCard(db, cy, c.course_id);
      const posts = slack.posted.length;
      const stopped = await rest('POST', `/courses/${c.course_id}/stop`);
      assert.equal(stopped.status, 'finished');
      const after = (await rest('GET', `/courses/${c.course_id}/students`)).students;
      assert.deepEqual(after.map((s: { status: string }) => s.status), ['completed']);
      assert.equal((await enrollmentOf(cy)).completedProgress, 0);
      assert.equal(slack.posted.length, posts + 1);
      assert.equal(slack.posted.at(-1)?.message.text, TEXT.ended(0));
      assert.equal(slack.replaced.at(-1)?.ts, cyCard?.messageTs); // Cy's open card is closed
      const twice = await api.call(tomToken, 'POST', `/courses/${c.course_id}/stop`);
      assert.deepEqual([twice.status, twice.body.error.code], [409, 'course_not_active']);
    },
  },
];

// Walkthrough sections that need later tasks (docs/scenario.md). Listed, not run.
const pending = [
  '1, 4, 5 through the MCP tools instead of REST: Task 9',
  '6 edge cases (reminders, removal and cleanup; stale-claim recovery runs above; the second click is checked above): Task 6b-2',
];

for (const [i, step] of steps.entries()) {
  try {
    await step.run();
    console.log(`ok   ${i + 1} ${step.name}`);
  } catch (err) {
    console.error(`FAIL ${i + 1} ${step.name}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`${i} ok, failed at step ${i + 1} of ${steps.length}, ${pending.length} pending not run`);
    process.exit(1); // the open server dies with the process
  }
}
for (const p of pending) console.log(`pending ${p}`);
console.log(`${steps.length} ok, ${pending.length} pending`);
await api.close();
await pool.end();
