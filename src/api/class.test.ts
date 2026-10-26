import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../db/testDb.js';
import { cardStates, enrollments, reviews, users } from '../db/schema.js';
import { getOpenCard } from '../db/selection.js';
import { submitAnswer } from '../services/answer.js';
import { afterAnswer } from '../services/scheduler.js';
import { issueTeacherToken } from '../services/auth.js';
import { draftCourse, harness, type Harness } from './harness.js';

let h: Harness;
let tom: string;
beforeAll(async () => {
  h = await harness();
  tom = await h.teacher();
});
afterAll(async () => {
  await h.api.close();
  await pool.end();
});

const call = (m: string, p: string, b?: unknown) => h.api.call(tom, m, p, b);
const enroll = (courseId: string, ...s: { email: string; name: string }[]) => call('POST', `/courses/${courseId}/students`, { students: s });
const studentList = async (courseId: string) => (await call('GET', `/courses/${courseId}/students`)).body.students as { student_id: string; email: string; status: string }[];
const enrollmentOf = async (courseId: string, userId: string) => (await db.select().from(enrollments).where(and(eq(enrollments.courseId, courseId), eq(enrollments.userId, userId))))[0];
const idOf = async (email: string) => (await db.select().from(users).where(eq(users.email, email)))[0]!.id;
/** A running course (4 cards, A1 assessment) with Ann enrolled, who holds the first card. */
async function running(extra: string[] = []) {
  const c = await draftCourse(h, tom, 4, 1);
  await call('PATCH', `/courses/${c.courseId}`, { ends_at: '2026-03-01T00:00:00Z' }); // far enough for the retention tests
  const ann = h.matched('ann');
  await enroll(c.courseId, { email: ann, name: 'Ann' }, ...extra.map((e) => ({ email: e, name: 'Extra' })));
  expect((await call('POST', `/courses/${c.courseId}/start`)).status).toBe(200);
  const annId = await idOf(ann);
  return { ...c, ann, annId };
}
/** Ann answers the open card the way a click would (right + medium). */
async function answer(userId: string, courseId: string, chosen: number | null = 0) {
  const open = (await getOpenCard(db, userId, courseId))!;
  const r = await submitAnswer(h.deps, { userId, flashcardId: open.flashcardId, chosenOption: chosen, ...(chosen === 0 && { rating: 'medium' as const }), ...(open.messageTs && { messageTs: open.messageTs }) });
  expect(r.status).toBe('answered');
  await afterAnswer(h.deps, userId, courseId, r);
  return open;
}

describe('enroll (R8)', () => {
  it('creates students, reports the Slack match, sends nothing to a draft course, keeps names, ignores duplicates', async () => {
    const { courseId } = await draftCourse(h, tom);
    const ann = h.matched('ann');
    const bob = h.email('bob');
    const posts = h.slack.posted.length;
    const r = await enroll(courseId, { email: ann.toUpperCase(), name: 'Ann' }, { email: bob, name: 'Bob' }, { email: ann, name: 'Ann again' });
    expect(r.status).toBe(200);
    expect(r.body.students).toEqual([
      { email: ann, enrolled: true, slack_matched: true, restored: false },
      { email: bob, enrolled: true, slack_matched: false, restored: false },
    ]);
    expect(h.slack.posted.length).toBe(posts);
    expect((await db.select().from(users).where(eq(users.email, ann)))[0]).toMatchObject({ role: 'student', fullName: 'Ann', tz: 'Europe/Zurich' });
    const again = await enroll(courseId, { email: ann, name: 'Ann' });
    expect(again.body.students[0]).toMatchObject({ enrolled: false, restored: false });
    const list = (await call('GET', `/courses/${courseId}/students`)).body.students;
    expect(list).toHaveLength(2);
    expect(list.find((s: { email: string }) => s.email === bob)).toMatchObject({ status: 'active', slack_matched: false, assessment_done_at: null, name: 'Bob', enrolled_at: '2026-01-05T09:00:00.000Z' });
    expect((await call('GET', `/courses/${courseId}`)).body.student_count).toBe(2);
  });

  it("a teacher's email is never enrolled and reveals nothing", async () => {
    const { courseId } = await draftCourse(h, tom);
    const teacherEmail = h.email('teacher2');
    await issueTeacherToken(db, { email: teacherEmail, fullName: 'Other teacher' });
    h.slack.directory.set(teacherEmail, { slackId: 'UTEACHER', tz: null });
    const r = await enroll(courseId, { email: teacherEmail, name: 'Not a student' });
    expect(r.body.students[0]).toEqual({ email: teacherEmail, enrolled: false, slack_matched: false, restored: false });
    expect((await call('GET', `/courses/${courseId}/students`)).body.students).toHaveLength(0);
  });

  it('a student matched later is matched on the next enrollment call', async () => {
    const { courseId } = await draftCourse(h, tom);
    const e = h.email('late');
    expect((await enroll(courseId, { email: e, name: 'L' })).body.students[0].slack_matched).toBe(false);
    h.slack.directory.set(e, { slackId: 'ULATE', tz: null });
    expect((await enroll(courseId, { email: e, name: 'L' })).body.students[0]).toMatchObject({ slack_matched: true, enrolled: false });
  });

  it.each([
    ['empty list', { students: [] }],
    ['bad email', { students: [{ email: 'nope', name: 'N' }] }],
    ['no name', { students: [{ email: 'a@b.test' }] }],
    ['unknown key', { students: [{ email: 'a@b.test', name: 'N', role: 'teacher' }] }],
    ['more than 500', { students: Array.from({ length: 501 }, (_, i) => ({ email: `s${i}@x.test`, name: 'N' })) }],
  ])('400 for %s', async (_n, body) => {
    const { courseId } = await draftCourse(h, tom);
    expect((await call('POST', `/courses/${courseId}/students`, body)).status).toBe(400);
  });

  it('a Slack outage during the lookup does not fail the enrollment', async () => {
    const { courseId } = await draftCourse(h, tom);
    const orig = h.slack.lookupEmail;
    h.slack.lookupEmail = async () => { throw new Error('slack down'); };
    const r = await enroll(courseId, { email: h.email('x'), name: 'X' });
    h.slack.lookupEmail = orig;
    expect(r.body.students[0]).toMatchObject({ enrolled: true, slack_matched: false });
  });

  it('on an active course the first assessment card goes out at once; an unmatched student gets nothing', async () => {
    const { courseId } = await running();
    const posts = h.slack.posted.length;
    const dee = h.matched('dee');
    await enroll(courseId, { email: dee, name: 'Dee' }, { email: h.email('nomatch'), name: 'N' });
    expect(h.slack.posted.length - posts).toBe(1);
    expect(h.slack.posted.at(-1)?.message.text).toMatch(/^Q: Q1/);
  });

  it('a finished course takes no students', async () => {
    const { courseId } = await running();
    await call('POST', `/courses/${courseId}/stop`);
    const r = await enroll(courseId, { email: h.email('x'), name: 'X' });
    expect([r.status, r.body.error.code]).toEqual([409, 'course_finished']);
  });
});

describe('remove and restore (R15 to R18, S40, S45)', () => {
  it('R15, R16, S40, S45: soft delete, card voided, message replaced, idempotent', async () => {
    const bea = h.matched('bea');
    const { courseId, annId } = await running([bea]);
    const open = await getOpenCard(db, annId, courseId);
    expect(open?.messageTs).toBeTruthy();
    expect((await call('GET', `/courses/${courseId}`)).body.student_count).toBe(2);

    clockTo('2026-01-06T10:00:00Z');
    const first = await call('DELETE', `/courses/${courseId}/students/${annId}`);
    expect(first.status).toBe(204);
    const removedAt = (await enrollmentOf(courseId, annId))!.removedAt;
    expect(removedAt?.toISOString()).toBe('2026-01-06T10:00:00.000Z');
    expect(h.slack.replaced.at(-1)).toMatchObject({ channel: open!.messageChannel, ts: open!.messageTs });
    expect(h.slack.replaced.at(-1)?.message.text).toBe('expired');
    const cs = (await db.select().from(cardStates).where(eq(cardStates.userId, annId)))[0]!;
    expect([cs.sentAt, cs.messageTs, cs.remindedAt, cs.reminderCount]).toEqual([null, null, null, 0]);

    expect((await studentList(courseId)).map((s) => s.student_id)).not.toContain(annId);
    expect((await call('GET', `/courses/${courseId}`)).body.student_count).toBe(1);
    const prog = (await call('GET', `/courses/${courseId}/progress`)).body;
    expect(prog.students.map((s: { student_id: string }) => s.student_id)).not.toContain(annId);
    expect((await call('GET', `/courses/${courseId}/students/${annId}/progress`)).status).toBe(404);

    clockTo('2026-01-07T10:00:00Z');
    const replaced = h.slack.replaced.length;
    expect((await call('DELETE', `/courses/${courseId}/students/${annId}`)).status).toBe(204);
    expect((await enrollmentOf(courseId, annId))!.removedAt).toEqual(removedAt);
    expect(h.slack.replaced.length).toBe(replaced);

    const click = await submitAnswer(h.deps, { userId: annId, flashcardId: open!.flashcardId, chosenOption: 0, rating: 'medium' });
    expect(click).toEqual({ status: 'rejected', reason: 'removed' });
  });

  it('an unknown or never-enrolled student is 404', async () => {
    const { courseId } = await running();
    const stranger = h.email('stranger');
    const other = await draftCourse(h, tom);
    await enroll(other.courseId, { email: stranger, name: 'S' });
    expect((await call('DELETE', `/courses/${courseId}/students/${await idOf(stranger)}`)).status).toBe(404);
    expect((await call('DELETE', `/courses/${courseId}/students/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });

  it('R17: re-enrolling within 14 days restores progress and sends the voided card again', async () => {
    const { courseId, annId, ann } = await running();
    await answer(annId, courseId); // A1 right + medium, then Q2 follows (new card, quota 1)
    const before = (await db.select().from(cardStates).where(eq(cardStates.userId, annId))).map((r) => [r.flashcardId, r.correctStreak, r.reps]).sort();
    const openBefore = await getOpenCard(db, annId, courseId);
    await call('DELETE', `/courses/${courseId}/students/${annId}`);
    h.clock.advanceDays(13);
    const posts = h.slack.posted.length;
    const r = await enroll(courseId, { email: ann, name: 'Ann' });
    expect(r.body.students[0]).toEqual({ email: ann, enrolled: true, slack_matched: true, restored: true });
    expect((await enrollmentOf(courseId, annId))!.removedAt).toBeNull();
    expect((await db.select().from(cardStates).where(eq(cardStates.userId, annId))).map((x) => [x.flashcardId, x.correctStreak, x.reps]).sort()).toEqual(before);
    expect(await db.select().from(reviews).where(eq(reviews.userId, annId))).toHaveLength(1);
    expect((await studentList(courseId)).map((s) => s.student_id)).toContain(annId);
    const sent = h.slack.posted.slice(posts).map((p) => p.message.text);
    expect(sent[0]).toBe('You are enrolled in this course again. Your progress is kept.');
    expect(sent).toHaveLength(2);
    expect((await getOpenCard(db, annId, courseId))?.flashcardId).toBe(openBefore!.flashcardId); // the voided card is open again
  });

  it('regression (attack run): parallel re-enrollments of a removed student restore once and send one DM', async () => {
    const { courseId, annId, ann } = await running();
    await call('DELETE', `/courses/${courseId}/students/${annId}`);
    const posts = h.slack.posted.length;
    const rs = await Promise.all(Array.from({ length: 8 }, () => enroll(courseId, { email: ann, name: 'Ann' })));
    expect(rs.filter((r) => r.body.students[0].restored)).toHaveLength(1);
    expect(h.slack.posted.slice(posts).filter((p) => p.message.text.startsWith('You are enrolled')).length).toBe(1);
  });

  it('R18 (cleanup simulated with a clock 15 days on; the daily job is Task 6b-2): a fresh enrollment, assessment first, old reviews gone', async () => {
    const c = await draftCourse(h, tom, 4, 1);
    await call('PATCH', `/courses/${c.courseId}`, { ends_at: '2026-03-01T00:00:00Z' });
    const ann = h.matched('ann');
    await enroll(c.courseId, { email: ann, name: 'Ann' });
    await call('POST', `/courses/${c.courseId}/start`);
    const annId = await idOf(ann);
    await answer(annId, c.courseId);
    expect(await db.select().from(reviews).where(eq(reviews.userId, annId))).toHaveLength(1);
    await call('DELETE', `/courses/${c.courseId}/students/${annId}`);
    h.clock.advanceDays(15);
    const r = await enroll(c.courseId, { email: ann, name: 'Ann' });
    expect(r.body.students[0]).toMatchObject({ enrolled: true, restored: false });
    expect(await db.select().from(reviews).where(eq(reviews.userId, annId))).toHaveLength(0);
    const e = (await enrollmentOf(c.courseId, annId))!;
    expect([e.removedAt, e.assessmentDoneAt, e.status]).toEqual([null, null, 'active']);
    expect((await getOpenCard(db, annId, c.courseId))?.flashcardId).toBe(c.cardIds[0]);
  });
});

function clockTo(iso: string) {
  h.clock.set(new Date(iso));
}
