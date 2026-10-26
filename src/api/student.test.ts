import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/testDb.js';
import { reviews, users } from '../db/schema.js';
import { getOpenCard } from '../db/selection.js';
import { draftCourse, harness, type Harness } from './harness.js';

let h: Harness;
let off: Harness;
let tom: string;
beforeAll(async () => {
  h = await harness({ studentRoutes: true });
  off = await harness();
  tom = await h.teacher();
});
afterAll(async () => {
  await h.api.close();
  await off.api.close();
  await pool.end();
});

const call = (m: string, p: string, b?: unknown) => h.api.call(m === 'GET' && p.startsWith('/courses') ? tom : null, m, p, b);
const idOf = async (email: string) => (await db.select().from(users).where(eq(users.email, email)))[0]!.id;
const answerPath = (u: string, c: string) => `/users/${u}/flashcards/${c}/reviews`;

/** A running course; Ann holds the open assessment card A1 (right option 0). */
async function running() {
  const c = await draftCourse(h, tom, 4, 1);
  await h.api.call(tom, 'PATCH', `/courses/${c.courseId}`, { ends_at: '2026-03-01T00:00:00Z' });
  const ann = h.matched('ann');
  const bea = h.matched('bea');
  await h.api.call(tom, 'POST', `/courses/${c.courseId}/students`, { students: [{ email: ann, name: 'Ann' }, { email: bea, name: 'Bea' }] });
  await h.api.call(tom, 'POST', `/courses/${c.courseId}/start`);
  const annId = await idOf(ann);
  return { ...c, annId, beaId: await idOf(bea), open: (await getOpenCard(db, annId, c.courseId))!.flashcardId };
}

describe('R19: disabled by default', () => {
  it('both student routes are 404 when STUDENT_ROUTES_ENABLED is off (and not 401)', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const a = await off.api.call(null, 'POST', answerPath(id, id), { chosen_option: 0, rating: 'easy' });
    const b = await off.api.call(null, 'GET', `/users/${id}/courses`);
    expect([a.status, a.body.error.code, b.status]).toEqual([404, 'not_found', 404]);
  });
});

describe('answer (R9 to R11)', () => {
  it('R9: a right answer without a rating is 400 and stores nothing; the card stays open', async () => {
    const { annId, open } = await running();
    for (const body of [{ chosen_option: 0 }, { chosen_option: 0, rating: 'great' }]) {
      const r = await call('POST', answerPath(annId, open), body);
      expect(r.status).toBe(400);
    }
    expect((await call('POST', answerPath(annId, open), { chosen_option: 0 })).body.error.code).toBe('rating_required');
    expect(await db.select().from(reviews).where(eq(reviews.userId, annId))).toHaveLength(0);
    expect((await db.select().from(reviews).where(eq(reviews.flashcardId, open))).filter((r) => r.userId === annId)).toHaveLength(0);
  });

  it('R10: a wrong answer with a rating is 200, rating null; the right option is revealed afterwards', async () => {
    const { annId, open } = await running();
    const r = await call('POST', answerPath(annId, open), { chosen_option: 2, rating: 'easy' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ is_correct: false, correct_option: 0, rating: null, material_url: 'https://x.test/m', progress: 0 });
  });

  it("Don't know (null) is a wrong answer; a right answer returns rating, progress and sends the next card", async () => {
    const { annId, open, courseId } = await running();
    const posts = h.slack.posted.length;
    const dk = await call('POST', answerPath(annId, open), { chosen_option: null });
    expect(dk.body).toMatchObject({ is_correct: false, rating: null });
    const second = (await getOpenCard(db, annId, courseId))?.flashcardId;
    expect(second).toBeDefined(); // the assessment card is due again tomorrow; a new card follows the evaluation
    const ok = await call('POST', answerPath(annId, second!), { chosen_option: 0, rating: 'medium' });
    expect(ok.body).toMatchObject({ is_correct: true, rating: 'medium', correct_option: 0 });
    expect(h.slack.posted.length).toBeGreaterThan(posts);
  });

  it('R11: correct_option never appears before the answer: not in the course list, not in refusals', async () => {
    const { annId, beaId, open, cardIds } = await running();
    const courses = await call('GET', `/users/${annId}/courses`);
    expect(JSON.stringify(courses.body)).not.toContain('correct_option');
    const wrongUser = await call('POST', answerPath(beaId, cardIds[1]!), { chosen_option: 0, rating: 'easy' }); // a card that was never sent to Bea
    expect(wrongUser.status).toBe(409);
    expect(JSON.stringify(wrongUser.body)).not.toContain('correct_option');
    expect((await call('POST', answerPath(annId, open), { chosen_option: 1 })).body.correct_option).toBe(0); // only after the answer
    const replay = await call('POST', answerPath(annId, open), { chosen_option: 0, rating: 'easy' });
    expect([replay.status, replay.body.error.code]).toEqual([409, 'not_open']);
    expect(JSON.stringify(replay.body)).not.toContain('correct_option');
  });

  it.each([
    ['option out of range', { chosen_option: 9, rating: 'easy' }, 'invalid_option'],
    ['negative option', { chosen_option: -1 }, 'invalid_request'],
    ['option is a string', { chosen_option: '0', rating: 'easy' }, 'invalid_request'],
    ['option missing', { rating: 'easy' }, 'invalid_request'],
    ['unknown key', { chosen_option: 0, rating: 'easy', is_correct: true }, 'invalid_request'],
  ])('400 for %s', async (_n, body, code) => {
    const { annId, open } = await running();
    const r = await call('POST', answerPath(annId, open), body);
    expect([r.status, r.body.error.code]).toEqual([400, code]);
  });

  it('GET /users/:userId/courses lists present enrollments with progress; an unknown user is 404', async () => {
    const { annId, courseId } = await running();
    const r = await call('GET', `/users/${annId}/courses`);
    expect(r.body.courses.find((c: { course_id: string }) => c.course_id === courseId)).toEqual({ course_id: courseId, title: 'Security basics', status: 'active', progress: 0, assessment_done: false, enrollment_status: 'active' });
    await h.api.call(tom, 'DELETE', `/courses/${courseId}/students/${annId}`);
    expect((await call('GET', `/users/${annId}/courses`)).body.courses.map((c: { course_id: string }) => c.course_id)).not.toContain(courseId);
    expect((await call('GET', '/users/00000000-0000-4000-8000-000000000000/courses')).status).toBe(404);
  });
});
