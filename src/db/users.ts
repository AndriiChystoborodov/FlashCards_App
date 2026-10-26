import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { users } from './schema.js';

export async function getUser(db: DbOrTx, id: string) {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row ?? null;
}

export async function setDmChannel(db: DbOrTx, id: string, channel: string): Promise<void> {
  await db.update(users).set({ slackDmChannel: channel }).where(eq(users.id, id));
}

export async function findUserByEmail(db: DbOrTx, email: string) {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  return row ?? null;
}

export async function findUserBySlackId(db: DbOrTx, slackId: string) {
  const [row] = await db.select().from(users).where(eq(users.slackId, slackId));
  return row ?? null;
}

/** Concurrent enrollments of one new email: the loser inserts nothing and the caller re-reads the row. */
export async function insertStudent(db: DbOrTx, v: { email: string; fullName: string }): Promise<void> {
  await db.insert(users).values({ ...v, role: 'student' }).onConflictDoNothing({ target: users.email });
}

export async function setSlackIdentity(db: DbOrTx, id: string, slackId: string, tz: string | null): Promise<void> {
  await db.update(users).set({ slackId, ...(tz && { tz }) }).where(eq(users.id, id));
}

export async function findTeacherByTokenHash(db: DbOrTx, hash: string) {
  const [row] = await db.select().from(users).where(and(eq(users.apiTokenHash, hash), eq(users.role, 'teacher')));
  return row ?? null;
}

export async function setTokenHash(db: DbOrTx, id: string, hash: string): Promise<void> {
  await db.update(users).set({ apiTokenHash: hash }).where(eq(users.id, id));
}

/** The teacher row for an email, created when missing (the token script). A student email is refused by the caller. */
export async function upsertTeacher(db: DbOrTx, v: { email: string; fullName: string }) {
  await db.insert(users).values({ ...v, role: 'teacher' }).onConflictDoNothing({ target: users.email });
  return (await findUserByEmail(db, v.email))!;
}
