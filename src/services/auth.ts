import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/client.js';
import { findTeacherByTokenHash, findUserByEmail, setTokenHash, upsertTeacher } from '../db/users.js';

/** Decision 0014: SHA-256 is enough because the token is 32 random bytes. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** The teacher behind a bearer token, or null. Only the hash is looked up. */
export async function teacherForToken(db: Db, token: string): Promise<string | null> {
  return (await findTeacherByTokenHash(db, hashToken(token)))?.id ?? null;
}

/** Creates the teacher if needed and overwrites the hash (revokes the old token). The caller prints the token once and never logs it. */
export async function issueTeacherToken(db: Db, v: { email: string; fullName: string }): Promise<string> {
  const email = v.email.trim().toLowerCase();
  const existing = await findUserByEmail(db, email);
  if (existing && existing.role !== 'teacher') throw new Error('that email belongs to a student');
  const teacher = await upsertTeacher(db, { email, fullName: v.fullName });
  const token = randomBytes(32).toString('base64url');
  await setTokenHash(db, teacher.id, hashToken(token));
  return token;
}
