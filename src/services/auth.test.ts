import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/testDb.js';
import { users } from '../db/schema.js';
import { hashToken, issueTeacherToken, teacherForToken } from './auth.js';

afterAll(() => pool.end());
const email = () => `auth-${crypto.randomUUID()}@x.test`;

describe('teacher tokens (decision 0014)', () => {
  it('issues 32 random bytes and stores only the SHA-256 hash', async () => {
    const e = email();
    const token = await issueTeacherToken(db, { email: e, fullName: 'T' });
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const row = (await db.select().from(users).where(eq(users.email, e)))[0]!;
    expect(row).toMatchObject({ role: 'teacher', apiTokenHash: hashToken(token) });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(await teacherForToken(db, token)).toBe(row.id);
    expect(await teacherForToken(db, token + 'x')).toBeNull();
  });

  it('reissuing revokes the old token; two teachers get different tokens', async () => {
    const e = email();
    const a = await issueTeacherToken(db, { email: e, fullName: 'T' });
    const b = await issueTeacherToken(db, { email: e.toUpperCase(), fullName: 'T' });
    expect(a).not.toBe(b);
    expect(await teacherForToken(db, a)).toBeNull();
    expect(await teacherForToken(db, b)).not.toBeNull();
  });

  it('refuses an email that belongs to a student, and a student never authenticates', async () => {
    const e = email();
    const stolen = crypto.randomUUID();
    const [s] = await db.insert(users).values({ email: e, fullName: 'S', role: 'student' }).returning();
    await expect(issueTeacherToken(db, { email: e, fullName: 'S' })).rejects.toThrow('belongs to a student');
    await db.update(users).set({ apiTokenHash: hashToken(stolen) }).where(eq(users.id, s!.id));
    expect(await teacherForToken(db, stolen)).toBeNull();
  });
});

describe('time comes only from the Clock', () => {
  it.each(['courses', 'flashcards', 'enrollment', 'progress', 'studentReview', 'auth'])('services/%s.ts has no new Date() or Date.now', (f) => {
    expect(readFileSync(new URL(`./${f}.ts`, import.meta.url), 'utf8')).not.toMatch(/new Date\(\)|Date\.now/);
  });
  it.each(['app', 'teacher', 'student', 'errors', 'present', 'schemas'])('api/%s.ts has no new Date() or Date.now', (f) => {
    expect(readFileSync(new URL(`../api/${f}.ts`, import.meta.url), 'utf8')).not.toMatch(/new Date\(\)|Date\.now/);
  });
});
