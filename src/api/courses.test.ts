import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/testDb.js';
import { courses, enrollments, flashcards } from '../db/schema.js';
import { cardBody, courseBody, draftCourse, harness, type Harness } from './harness.js';

let h: Harness;
let tom: string;
let eve: string;
beforeAll(async () => {
  h = await harness();
  tom = await h.teacher();
  eve = await h.teacher();
});
afterAll(async () => {
  await h.api.close();
  await pool.end();
});

const call = (t: string | null, m: string, p: string, b?: unknown) => h.api.call(t, m, p, b);
const errorCode = (r: { body: any }) => r.body.error.code;

describe('auth (R1)', () => {
  it('no token, a wrong token and a malformed header are 401 with the documented shape', async () => {
    for (const t of [null, 'x'.repeat(43), 'short']) {
      const r = await call(t, 'GET', '/courses');
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
    }
    const raw = await fetch(`${h.api.url}/courses`, { headers: { authorization: 'Basic abc' } });
    expect(raw.status).toBe(401);
  });

  it('a request without a token is refused before its body is parsed (bad JSON is 401, not 400)', async () => {
    const r = await call(null, 'POST', '/courses', '{ nope');
    expect(r.status).toBe(401);
  });

  it('an unknown route is 404 in the same shape, not 401', async () => {
    const r = await call(null, 'GET', '/nope');
    expect(r.status).toBe(404);
    expect(errorCode(r)).toBe('not_found');
  });

  it('never echoes the token, in bodies or logs (bad JSON, bad fields, 404, 409)', async () => {
    const logs: string[] = [];
    const spies = (['log', 'warn', 'error', 'info'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(JSON.stringify(a))));
    const bodies: string[] = [];
    const seen = async (p: Promise<{ status: number; body: unknown }>) => bodies.push(JSON.stringify(await p));
    await seen(call(tom, 'POST', '/courses', '{ "title": '));
    await seen(call(tom, 'POST', '/courses', { title: tom, material_url: tom, ends_at: tom, extra: tom }));
    await seen(call(tom, 'GET', `/courses/${tom}`));
    await seen(call(eve, 'GET', '/courses/00000000-0000-4000-8000-000000000000'));
    await seen(call(tom, 'POST', '/courses', courseBody({ title: 'x' })).then(async (r) => call(tom, 'DELETE', `/courses/${r.body.course_id}/students/${tom}`)));
    await seen(call(`${tom}x`, 'GET', '/courses'));
    spies.forEach((s) => s.mockRestore());
    for (const text of [...bodies, ...logs]) {
      expect(text).not.toContain(tom);
      expect(text).not.toContain(eve);
    }
  });

  it('is not stored: the table holds a hash, not the token', async () => {
    const { rows } = await pool.query<{ api_token_hash: string }>('select api_token_hash from users where api_token_hash is not null and api_token_hash = $1', [tom]);
    expect(rows).toHaveLength(0);
  });
});

describe('create and read (R2, R3)', () => {
  it('creates a draft with threshold 90 and counts', async () => {
    const r = await call(tom, 'POST', '/courses', courseBody());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'draft', assessment_pass_threshold: 90, card_count: 0, assessment_card_count: 0, student_count: 0, scheduled_start_at: null, starts_at: null, ends_at: '2026-01-16T22:59:00.000Z' });
    const g = await call(tom, 'GET', `/courses/${r.body.course_id}`);
    expect(g.body).toEqual(r.body);
    expect((await call(tom, 'GET', '/courses')).body.courses.map((c: { course_id: string }) => c.course_id)).toContain(r.body.course_id);
  });

  it.each([
    ['missing ends_at', { title: 'T', material_url: 'https://x.test' }],
    ['unknown key', courseBody({ teacher_id: 'x' })],
    ['threshold 0', courseBody({ assessment_pass_threshold: 0 })],
    ['threshold 101', courseBody({ assessment_pass_threshold: 101 })],
    ['threshold 90.5', courseBody({ assessment_pass_threshold: 90.5 })],
    ['ends_at without a zone', courseBody({ ends_at: '2026-01-16T22:59:00' })],
    ['javascript: url', courseBody({ material_url: 'javascript:alert(1)' })],
    ['title is a number', courseBody({ title: 5 })],
    ['empty title', courseBody({ title: '   ' })],
  ])('400 for %s', async (_n, body) => {
    const r = await call(tom, 'POST', '/courses', body);
    expect(r.status).toBe(400);
    expect(errorCode(r)).toBe('invalid_request');
  });

  it('400 for bad JSON, a non-JSON content type and a huge body; nothing is created', async () => {
    const before = (await call(tom, 'GET', '/courses')).body.courses.length;
    expect((await call(tom, 'POST', '/courses', '{ nope')).status).toBe(400);
    const text = await fetch(`${h.api.url}/courses`, { method: 'POST', headers: { authorization: `Bearer ${tom}`, 'content-type': 'text/plain' }, body: JSON.stringify(courseBody()) });
    expect(text.status).toBe(400);
    expect((await call(tom, 'POST', '/courses', courseBody({ title: 'x'.repeat(2_000_000) }))).status).toBe(400);
    expect((await call(tom, 'GET', '/courses')).body.courses.length).toBe(before);
  });

  it('regression (attack run): NUL bytes, year 0 and bad percent-encoding or gzip are 4xx, never 500', async () => {
    const { courseId } = await draftCourse(h, tom);
    for (const [m, p, b] of [
      ['POST', '/courses', courseBody({ title: 'a\u0000b' })],
      ['PATCH', `/courses/${courseId}`, { material_url: 'https://x.test/a\u0000' }],
      ['POST', `/courses/${courseId}/flashcards`, { flashcards: [cardBody({ options: ['a\u0000', 'b'] })] }],
      ['POST', `/courses/${courseId}/students`, { students: [{ email: 'a@x.test', name: 'a\u0000' }] }],
      ['POST', '/courses', courseBody({ ends_at: '0000-01-01T00:00:00Z' })],
      ['PATCH', `/courses/${courseId}`, { ends_at: '0001-01-01T00:00:00Z' }],
    ] as const) expect((await call(tom, m, p, b)).status, `${m} ${p}`).toBe(400);
    expect((await call(tom, 'GET', '/courses/%')).status).toBe(404);
    expect((await call(tom, 'GET', '/courses/%E0%A4%A')).status).toBe(404);
    const gz = await fetch(`${h.api.url}/courses`, { method: 'POST', headers: { authorization: `Bearer ${tom}`, 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: JSON.stringify(courseBody()) });
    expect(gz.status).toBe(400);
  });

  it('a malformed id is 404', async () => {
    expect((await call(tom, 'GET', '/courses/not-a-uuid')).status).toBe(404);
    expect((await call(tom, 'DELETE', "/courses/1'%20or%201=1")).status).toBe(404);
  });
});

describe("another teacher's data (R2): every teacher route is 404 and changes nothing", () => {
  it('table-driven over all routes', async () => {
    const { courseId, cardIds } = await draftCourse(h, tom);
    const ann = h.matched('ann');
    const enrolled = await call(tom, 'POST', `/courses/${courseId}/students`, { students: [{ email: ann, name: 'Ann' }] });
    expect(enrolled.status).toBe(200);
    const students = (await call(tom, 'GET', `/courses/${courseId}/students`)).body.students;
    const annId: string = students[0].student_id;

    const routes: [string, string, unknown?][] = [
      ['GET', `/courses/${courseId}`],
      ['PATCH', `/courses/${courseId}`, { title: 'hacked' }],
      ['POST', `/courses/${courseId}/start`],
      ['POST', `/courses/${courseId}/stop`],
      ['DELETE', `/courses/${courseId}`],
      ['POST', `/courses/${courseId}/flashcards`, { flashcards: [cardBody()] }],
      ['GET', `/courses/${courseId}/flashcards`],
      ['PATCH', `/flashcards/${cardIds[0]}`, { is_assessment: true }],
      ['DELETE', `/flashcards/${cardIds[0]}`],
      ['POST', `/courses/${courseId}/students`, { students: [{ email: h.email('mallory'), name: 'M' }] }],
      ['GET', `/courses/${courseId}/students`],
      ['DELETE', `/courses/${courseId}/students/${annId}`],
      ['GET', `/courses/${courseId}/progress`],
      ['GET', `/courses/${courseId}/students/${annId}/progress`],
    ];
    const snapshot = async () => ({
      c: await db.select().from(courses).where(eq(courses.id, courseId)),
      f: await db.select().from(flashcards).where(eq(flashcards.courseId, courseId)),
      e: await db.select().from(enrollments).where(eq(enrollments.courseId, courseId)),
      users: (await pool.query('select count(*)::int as n from users')).rows[0].n - 0,
    });
    const before = await snapshot();
    for (const [m, p, b] of routes) {
      const r = await call(eve, m, p, b);
      expect({ route: `${m} ${p}`, status: r.status, code: r.body?.error?.code }).toEqual({ route: `${m} ${p}`, status: 404, code: 'not_found' });
    }
    const after = await snapshot();
    expect(after.c).toEqual(before.c);
    expect(after.f).toEqual(before.f);
    expect(after.e).toEqual(before.e);
    expect(after.users).toBeGreaterThanOrEqual(before.users); // other tests add users in parallel; the enroll attempt must not have added Mallory:
    expect((await pool.query("select 1 from users where email like 'mallory-%' and full_name = 'M'")).rowCount).toBe(0);
    expect((await call(eve, 'GET', '/courses')).body.courses.map((c: { course_id: string }) => c.course_id)).not.toContain(courseId);
  });
});

describe('start and stop (R5, R6)', () => {
  it('start with zero cards is 409 no_cards', async () => {
    const c = await call(tom, 'POST', '/courses', courseBody());
    const r = await call(tom, 'POST', `/courses/${c.body.course_id}/start`);
    expect([r.status, errorCode(r)]).toEqual([409, 'no_cards']);
  });

  it('start with ends_at in the past is 409 ends_at_passed', async () => {
    const { courseId } = await draftCourse(h, tom);
    await call(tom, 'PATCH', `/courses/${courseId}`, { ends_at: '2026-01-04T00:00:00Z' });
    const r = await call(tom, 'POST', `/courses/${courseId}/start`);
    expect([r.status, errorCode(r)]).toEqual([409, 'ends_at_passed']);
  });

  it('draft to active to finished only; students get the start DM, the first card and the stop message', async () => {
    const { courseId } = await draftCourse(h, tom, 3, 1);
    const ann = h.matched('ann');
    const bea = h.matched('bea');
    await call(tom, 'POST', `/courses/${courseId}/students`, { students: [{ email: ann, name: 'Ann' }, { email: bea, name: 'Bea' }] });
    expect((await call(tom, 'POST', `/courses/${courseId}/stop`)).body.error.code).toBe('course_not_active');
    const posts = h.slack.posted.length;
    const s = await call(tom, 'POST', `/courses/${courseId}/start`);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ status: 'active', starts_at: '2026-01-05T09:00:00.000Z', student_count: 2, card_count: 3 });
    expect(h.slack.posted.length - posts).toBe(4); // start DM + first assessment card, twice
    expect(h.slack.posted.slice(posts).map((p) => p.message.text).filter((t) => t.startsWith('Q: ')).length).toBe(2);
    expect(errorCode(await call(tom, 'POST', `/courses/${courseId}/start`))).toBe('course_not_draft');
    const stop = await call(tom, 'POST', `/courses/${courseId}/stop`);
    expect(stop.body.status).toBe('finished');
    const st = (await call(tom, 'GET', `/courses/${courseId}/students`)).body.students;
    expect(st.map((x: { status: string }) => x.status)).toEqual(['completed', 'completed']);
    expect(errorCode(await call(tom, 'POST', `/courses/${courseId}/stop`))).toBe('course_not_active');
    expect(errorCode(await call(tom, 'POST', `/courses/${courseId}/start`))).toBe('course_not_draft');
  });
});

describe('PATCH rules (R26 to R29)', () => {
  const field = (cid: string) => db.select().from(courses).where(eq(courses.id, cid)).then((r) => r[0]!);
  const startedCourse = async () => {
    const { courseId } = await draftCourse(h, tom);
    expect((await call(tom, 'POST', `/courses/${courseId}/start`)).status).toBe(200);
    return courseId;
  };

  it('R28: draft takes ends_at (any value) and threshold', async () => {
    const { courseId } = await draftCourse(h, tom);
    const r = await call(tom, 'PATCH', `/courses/${courseId}`, { ends_at: '2026-01-10T00:00:00Z', assessment_pass_threshold: 80, title: 'New', scheduled_start_at: '2026-01-06T08:00:00Z' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ title: 'New', assessment_pass_threshold: 80, ends_at: '2026-01-10T00:00:00.000Z', scheduled_start_at: '2026-01-06T08:00:00.000Z' });
    expect((await call(tom, 'PATCH', `/courses/${courseId}`, { scheduled_start_at: null })).body.scheduled_start_at).toBeNull();
  });

  it('R26: threshold on an active course is 409 threshold_locked, value unchanged (even the same value)', async () => {
    const id = await startedCourse();
    for (const v of [50, 90]) {
      const r = await call(tom, 'PATCH', `/courses/${id}`, { assessment_pass_threshold: v, title: 'changed too' });
      expect([r.status, errorCode(r)]).toEqual([409, 'threshold_locked']);
    }
    expect(await field(id)).toMatchObject({ assessmentPassThreshold: 90, title: 'Security basics' });
  });

  it('R27 and R28: ends_at earlier is 409 ends_at_shortened; later is saved; equal is accepted', async () => {
    const id = await startedCourse();
    const r = await call(tom, 'PATCH', `/courses/${id}`, { ends_at: '2026-01-16T22:58:59Z' });
    expect([r.status, errorCode(r)]).toEqual([409, 'ends_at_shortened']);
    expect((await field(id)).endsAt.toISOString()).toBe('2026-01-16T22:59:00.000Z');
    expect((await call(tom, 'PATCH', `/courses/${id}`, { ends_at: '2026-01-16T22:59:00Z' })).status).toBe(200);
    expect((await call(tom, 'PATCH', `/courses/${id}`, { ends_at: '2026-01-20T22:59:00Z', title: 'ok' })).body).toMatchObject({ ends_at: '2026-01-20T22:59:00.000Z', title: 'ok' });
  });

  it('R29: any PATCH on a finished course is 409 course_finished', async () => {
    const id = await startedCourse();
    await call(tom, 'POST', `/courses/${id}/stop`);
    for (const body of [{ title: 'x' }, { ends_at: '2027-01-01T00:00:00Z' }, { assessment_pass_threshold: 70 }]) {
      const r = await call(tom, 'PATCH', `/courses/${id}`, body);
      expect([r.status, errorCode(r)]).toEqual([409, 'course_finished']);
    }
    expect((await field(id)).title).toBe('Security basics');
  });

  it('400 for an empty body and an unknown key; status is not patchable', async () => {
    const { courseId } = await draftCourse(h, tom);
    for (const b of [{}, { status: 'active' }, { teacher_id: 'x' }, { ends_at: 'tomorrow' }]) expect((await call(tom, 'PATCH', `/courses/${courseId}`, b)).status).toBe(400);
    expect((await field(courseId)).status).toBe('draft');
  });
});

describe('delete', () => {
  it('a draft with cards and students is deleted with them (204); a running course is 409', async () => {
    const { courseId } = await draftCourse(h, tom);
    await call(tom, 'POST', `/courses/${courseId}/students`, { students: [{ email: h.email('x'), name: 'X' }] });
    expect((await call(tom, 'DELETE', `/courses/${courseId}`)).status).toBe(204);
    expect(await db.select().from(flashcards).where(eq(flashcards.courseId, courseId))).toHaveLength(0);
    expect(await db.select().from(enrollments).where(eq(enrollments.courseId, courseId))).toHaveLength(0);
    expect((await call(tom, 'GET', `/courses/${courseId}`)).status).toBe(404);
    const run = await draftCourse(h, tom);
    await call(tom, 'POST', `/courses/${run.courseId}/start`);
    const r = await call(tom, 'DELETE', `/courses/${run.courseId}`);
    expect([r.status, errorCode(r)]).toEqual([409, 'course_not_draft']);
  });
});
