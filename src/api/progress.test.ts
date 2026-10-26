import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../db/testDb.js';
import { cardStates, enrollments, flashcards, users } from '../db/schema.js';
import { getOpenCard } from '../db/selection.js';
import { submitAnswer } from '../services/answer.js';
import { afterAnswer } from '../services/scheduler.js';
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
const idOf = async (email: string) => (await db.select().from(users).where(eq(users.email, email)))[0]!.id;
const classProgress = async (courseId: string) => (await call('GET', `/courses/${courseId}/progress`)).body;
const studentProgress = async (courseId: string, id: string) => (await call('GET', `/courses/${courseId}/students/${id}/progress`)).body;

/** A running course of 4 cards (A1 assessment) with Ann, Bea; both hold A1. */
async function running() {
  const c = await draftCourse(h, tom, 4, 1);
  await call('PATCH', `/courses/${c.courseId}`, { ends_at: '2026-03-01T00:00:00Z' });
  const emails = { ann: h.matched('ann'), bea: h.matched('bea') };
  await call('POST', `/courses/${c.courseId}/students`, { students: Object.entries(emails).map(([name, email]) => ({ email, name })) });
  await call('POST', `/courses/${c.courseId}/start`);
  return { ...c, annId: await idOf(emails.ann), beaId: await idOf(emails.bea), emails };
}
const setLearned = (userId: string, flashcardId: string) => db.update(cardStates).set({ learnedAt: new Date('2026-01-05T10:00:00Z') }).where(and(eq(cardStates.userId, userId), eq(cardStates.flashcardId, flashcardId)));

describe('waiting_since (R22 to R25)', () => {
  it('R22: the open card gives the card sent_at, no open card gives null', async () => {
    const { courseId, annId } = await running();
    const p = await classProgress(courseId);
    expect(p.students.map((s: { waiting_since: string }) => s.waiting_since)).toEqual(['2026-01-05T09:00:00.000Z', '2026-01-05T09:00:00.000Z']);
    expect((await studentProgress(courseId, annId)).waiting_since).toBe('2026-01-05T09:00:00.000Z');
    const fresh = await draftCourse(h, tom);
    await call('POST', `/courses/${fresh.courseId}/students`, { students: [{ email: h.email('nomatch'), name: 'N' }] });
    await call('POST', `/courses/${fresh.courseId}/start`);
    expect((await classProgress(fresh.courseId)).students[0].waiting_since).toBeNull();
  });

  it('R23 (the reminders are Task 6b-2, so reminder_count is set directly): ten days and three reminders do not move waiting_since; no card is sent', async () => {
    const { courseId, annId } = await running();
    h.clock.advanceDays(10);
    await db.update(cardStates).set({ reminderCount: 3, remindedAt: h.clock.now() }).where(eq(cardStates.userId, annId));
    const posts = h.slack.posted.length;
    expect((await studentProgress(courseId, annId)).waiting_since).toBe('2026-01-05T09:00:00.000Z');
    expect((await classProgress(courseId)).students.find((s: { student_id: string }) => s.student_id === annId).waiting_since).toBe('2026-01-05T09:00:00.000Z');
    expect(h.slack.posted.length).toBe(posts);
    h.clock.set(new Date('2026-01-05T09:00:00Z'));
  });

  it('R24: after the answer waiting_since is null in both endpoints (until the next card is sent)', async () => {
    const { courseId, annId } = await running();
    const open = (await getOpenCard(db, annId, courseId))!;
    const r = await submitAnswer(h.deps, { userId: annId, flashcardId: open.flashcardId, chosenOption: 0, rating: 'medium' });
    expect((await studentProgress(courseId, annId)).waiting_since).toBeNull();
    expect((await classProgress(courseId)).students.find((s: { student_id: string }) => s.student_id === annId).waiting_since).toBeNull();
    h.clock.set(new Date('2026-01-05T13:00:00Z'));
    await afterAnswer(h.deps, annId, courseId, r);
    expect((await studentProgress(courseId, annId)).waiting_since).toBe('2026-01-05T13:00:00.000Z'); // the next card
    h.clock.set(new Date('2026-01-05T09:00:00Z'));
  });

  it('R25: removed students leave the lists; after a restore waiting_since is the new send, not the old one', async () => {
    const { courseId, annId, emails } = await running();
    await call('DELETE', `/courses/${courseId}/students/${annId}`);
    expect((await classProgress(courseId)).students.map((s: { student_id: string }) => s.student_id)).not.toContain(annId);
    h.clock.set(new Date('2026-01-06T09:00:00Z'));
    await call('POST', `/courses/${courseId}/students`, { students: [{ email: emails.ann, name: 'Ann' }] });
    expect((await studentProgress(courseId, annId)).waiting_since).toBe('2026-01-06T09:00:00.000Z');
    h.clock.set(new Date('2026-01-05T09:00:00Z'));
  });
});

describe('progress values (S20, S45)', () => {
  it('learned over total for active, 100 for exempt, the frozen value for completed; removed students are not averaged', async () => {
    const { courseId, cardIds, annId, beaId } = await running();
    const cy = h.matched('cy');
    const dee = h.matched('dee');
    await call('POST', `/courses/${courseId}/students`, { students: [{ email: cy, name: 'Cy' }, { email: dee, name: 'Dee' }] });
    await setLearned(annId, cardIds[0]!);
    await db.update(enrollments).set({ status: 'exempt' }).where(eq(enrollments.userId, beaId));
    await db.update(enrollments).set({ status: 'completed', completedProgress: 40 }).where(eq(enrollments.userId, await idOf(cy)));
    const deeId = await idOf(dee);
    expect((await classProgress(courseId)).class_progress).toBe(41.25); // (25 + 100 + 40 + 0) / 4
    await call('DELETE', `/courses/${courseId}/students/${deeId}`);
    const p = await classProgress(courseId);
    expect(p).toMatchObject({ course_id: courseId, class_progress: 55 }); // (25 + 100 + 40) / 3
    const byName = Object.fromEntries(p.students.map((s: { name: string }) => [s.name, s]));
    expect(byName.ann).toMatchObject({ status: 'active', progress: 25, learned: 1, total: 4, assessment_done: false });
    expect(byName.bea).toMatchObject({ status: 'exempt', progress: 100, learned: 0, total: 4 });
    expect(byName.Cy).toMatchObject({ status: 'completed', progress: 40 });
  });

  it('an empty class and a course with no cards are 0, not NaN', async () => {
    const c = await call('POST', '/courses', { title: 'E', material_url: 'https://x.test', ends_at: '2026-02-01T00:00:00Z' });
    expect((await classProgress(c.body.course_id))).toEqual({ course_id: c.body.course_id, class_progress: 0, students: [] });
    await call('POST', `/courses/${c.body.course_id}/students`, { students: [{ email: h.email('x'), name: 'X' }] });
    expect((await classProgress(c.body.course_id)).students[0]).toMatchObject({ progress: 0, total: 0 });
  });

  it('rounds to two decimals', async () => {
    const { courseId, annId, cardIds } = await running();
    await db.insert(flashcards).values({ courseId, question: 'extra', options: ['a', 'b'], correctOption: 0, isAssessment: false, position: 9 });
    // 4 cards + 2 = 6; 1 of 6 = 16.666...
    await db.insert(flashcards).values({ courseId, question: 'extra2', options: ['a', 'b'], correctOption: 0, isAssessment: false, position: 10 });
    await setLearned(annId, cardIds[0]!);
    expect((await studentProgress(courseId, annId)).progress).toBe(16.67);
  });

  it('the student endpoint lists every card: learned, streak, due, last answer', async () => {
    const { courseId, cardIds, annId } = await running();
    const open = (await getOpenCard(db, annId, courseId))!;
    await submitAnswer(h.deps, { userId: annId, flashcardId: open.flashcardId, chosenOption: 0, rating: 'easy' });
    const p = await studentProgress(courseId, annId);
    expect(p.cards.map((c: { flashcard_id: string }) => c.flashcard_id)).toEqual(cardIds);
    expect(p.cards[0]).toMatchObject({ question: 'Q1', learned: false, correct_streak: 1, last_answer_correct: true });
    expect(p.cards[0].due).toEqual(expect.any(String));
    expect(p.cards[1]).toEqual({ flashcard_id: cardIds[1], question: 'Q2', learned: false, correct_streak: 0, due: null, last_answer_correct: null });
  });
});
