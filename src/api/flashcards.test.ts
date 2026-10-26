import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/testDb.js';
import { flashcards } from '../db/schema.js';
import { cardBody, draftCourse, harness, type Harness } from './harness.js';

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
const rows = (courseId: string) => db.select().from(flashcards).where(eq(flashcards.courseId, courseId));
const cardRow = async (id: string) => (await db.select().from(flashcards).where(eq(flashcards.id, id)))[0];
const running = async () => {
  const c = await draftCourse(h, tom, 3, 1);
  expect((await call('POST', `/courses/${c.courseId}/start`)).status).toBe(200);
  return c;
};

describe('add (R4, R13)', () => {
  it.each([
    ['correct_option past the options', cardBody({ correct_option: 3 })],
    ['negative correct_option', cardBody({ correct_option: -1 })],
    ['one option', cardBody({ options: ['a'] })],
    ['ten options', cardBody({ options: Array.from({ length: 10 }, (_, i) => `o${i}`) })],
    ['an empty option', cardBody({ options: ['a', ''] })],
    ['question and options over 2900 characters', cardBody({ question: 'q'.repeat(2891), options: ['aaaaa', 'bbbbb'] })],
    ['options not strings', cardBody({ options: [1, 2] })],
    ['unknown key', cardBody({ explanation: 'x' })],
  ])('R4: 400 for %s and nothing is stored', async (_n, card) => {
    const { courseId } = await draftCourse(h, tom, 1, 0);
    const r = await call('POST', `/courses/${courseId}/flashcards`, { flashcards: [cardBody(), card] });
    expect([r.status, r.body.error.code]).toEqual([400, 'invalid_request']);
    expect(await rows(courseId)).toHaveLength(1);
  });

  it('nine options and exactly 2900 characters are accepted; positions run 1..n in order', async () => {
    const { courseId } = await draftCourse(h, tom, 2, 0);
    const r = await call('POST', `/courses/${courseId}/flashcards`, {
      flashcards: [cardBody({ options: Array.from({ length: 9 }, (_, i) => `o${i}`), correct_option: 8 }), cardBody({ question: 'q'.repeat(2890), options: ['aaaaa', 'bbbbb'] })],
    });
    expect(r.status).toBe(201);
    expect(r.body.flashcards.map((f: { position: number }) => f.position)).toEqual([3, 4]);
  });

  it('R13: an active course takes plain cards at the end (201); an assessment card is 400 assessment_closed and nothing is added', async () => {
    const { courseId } = await running();
    const ok = await call('POST', `/courses/${courseId}/flashcards`, { flashcards: [cardBody({ question: 'late' })] });
    expect([ok.status, ok.body.flashcards[0].position]).toEqual([201, 4]);
    const bad = await call('POST', `/courses/${courseId}/flashcards`, { flashcards: [cardBody(), cardBody({ is_assessment: true })] });
    expect([bad.status, bad.body.error.code]).toEqual([400, 'assessment_closed']);
    expect(await rows(courseId)).toHaveLength(4);
  });

  it('R14: a finished course is 409 course_finished', async () => {
    const { courseId } = await running();
    await call('POST', `/courses/${courseId}/stop`);
    const r = await call('POST', `/courses/${courseId}/flashcards`, { flashcards: [cardBody()] });
    expect([r.status, r.body.error.code]).toEqual([409, 'course_finished']);
  });

  it('two requests at once get distinct positions', async () => {
    const { courseId } = await draftCourse(h, tom, 1, 0);
    await Promise.all([1, 2, 3, 4].map(() => call('POST', `/courses/${courseId}/flashcards`, { flashcards: [cardBody(), cardBody()] })));
    const positions = (await rows(courseId)).map((c) => c.position).sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 9 }, (_, i) => i + 1));
  });
});

describe('list', () => {
  it('lists the teacher view with correct_option, by position', async () => {
    const { courseId } = await draftCourse(h, tom, 3, 1);
    const r = await call('GET', `/courses/${courseId}/flashcards`);
    expect(r.body.flashcards.map((f: { question: string }) => f.question)).toEqual(['Q1', 'Q2', 'Q3']);
    expect(r.body.flashcards[0]).toMatchObject({ correct_option: 0, is_assessment: true, options: ['right', 'x', 'y'], position: 1, material_url: null });
  });
});

describe('patch and delete (R7, R12, R14, R21)', () => {
  it('R12: a draft course allows both; position renumbers the course', async () => {
    const { courseId, cardIds } = await draftCourse(h, tom, 3, 0);
    const r = await call('PATCH', `/flashcards/${cardIds[2]}`, { is_assessment: true, position: 1, material_url: 'https://x.test/new' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ is_assessment: true, position: 1, material_url: 'https://x.test/new' });
    expect((await rows(courseId)).sort((a, b) => a.position - b.position).map((c) => c.question)).toEqual(['Q3', 'Q1', 'Q2']);
    expect((await call('PATCH', `/flashcards/${cardIds[2]}`, { position: 99 })).body.position).toBe(3);
    expect((await call('PATCH', `/flashcards/${cardIds[2]}`, { material_url: null })).body.material_url).toBeNull();
    expect((await call('DELETE', `/flashcards/${cardIds[0]}`)).status).toBe(204);
    expect(await rows(courseId)).toHaveLength(2);
    expect((await call('DELETE', `/flashcards/${cardIds[0]}`)).status).toBe(404);
  });

  it('question and options are never editable; empty and unknown bodies are 400', async () => {
    const { cardIds } = await draftCourse(h, tom, 1, 0);
    for (const b of [{ question: 'x' }, { options: ['a', 'b'] }, { correct_option: 1 }, {}, { position: 0 }]) expect((await call('PATCH', `/flashcards/${cardIds[0]}`, b)).status).toBe(400);
  });

  it('R7 and R21: on an active course patch (incl. is_assessment) and delete are 409 course_not_draft, card unchanged', async () => {
    const { cardIds } = await running();
    const before = await cardRow(cardIds[1]!);
    for (const [m, b] of [['PATCH', { is_assessment: true }], ['PATCH', { position: 1 }], ['PATCH', { material_url: null }], ['DELETE', undefined]] as const) {
      const r = await call(m, `/flashcards/${cardIds[1]}`, b);
      expect([r.status, r.body.error.code]).toEqual([409, 'course_not_draft']);
    }
    expect(await cardRow(cardIds[1]!)).toEqual(before);
  });

  it('R14: on a finished course patch and delete are 409 course_not_draft', async () => {
    const { courseId, cardIds } = await running();
    await call('POST', `/courses/${courseId}/stop`);
    for (const [m, b] of [['PATCH', { is_assessment: false }], ['DELETE', undefined]] as const) {
      const r = await call(m, `/flashcards/${cardIds[0]}`, b);
      expect([r.status, r.body.error.code]).toEqual([409, 'course_not_draft']);
    }
    expect(await rows(courseId)).toHaveLength(3);
  });
});
