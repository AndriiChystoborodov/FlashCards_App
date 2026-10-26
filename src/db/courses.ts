import { and, eq, lte } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { courses } from './schema.js';

export async function getCourse(db: DbOrTx, id: string) {
  const [row] = await db.select().from(courses).where(eq(courses.id, id));
  return row ?? null;
}

/** `active` to `finished` (also used by stop, Task 7). Returns false when the course was not active. */
export async function finishCourse(db: DbOrTx, id: string): Promise<boolean> {
  const rows = await db.update(courses).set({ status: 'finished' }).where(and(eq(courses.id, id), eq(courses.status, 'active'))).returning({ id: courses.id });
  return rows.length > 0;
}

export const listEndedCourseIds = async (db: DbOrTx, now: Date): Promise<string[]> =>
  (await db.select({ id: courses.id }).from(courses).where(and(eq(courses.status, 'active'), lte(courses.endsAt, now)))).map((r) => r.id);
