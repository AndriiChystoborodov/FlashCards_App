import { and, asc, eq, getTableColumns, lte, sql } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { presentEnrollment } from './enrollments.js';
import { courses, enrollments, flashcards } from './schema.js';

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

export type Course = typeof courses.$inferSelect;
export type CourseWithCounts = Course & { cardCount: number; assessmentCardCount: number; studentCount: number };

// `${courses.id}` inside a subquery is printed without its table name and would match the inner table's own `id`.
const COURSE_ID = sql.raw('"courses"."id"');
const withCounts = {
  cardCount: sql<number>`(select count(*)::int from ${flashcards} where ${flashcards.courseId} = ${COURSE_ID})`,
  assessmentCardCount: sql<number>`(select count(*)::int from ${flashcards} where ${flashcards.courseId} = ${COURSE_ID} and ${flashcards.isAssessment})`,
  studentCount: sql<number>`(select count(*)::int from ${enrollments} where ${enrollments.courseId} = ${COURSE_ID} and ${presentEnrollment})`,
};

export const insertCourse = async (db: DbOrTx, v: typeof courses.$inferInsert) => (await db.insert(courses).values(v).returning())[0]!;

/** `courseId` narrows to one course; the teacher filter is what keeps other teachers' courses invisible. */
export async function listCoursesWithCounts(db: DbOrTx, teacherId: string, courseId?: string): Promise<CourseWithCounts[]> {
  return db
    .select({ ...getTableColumns(courses), ...withCounts })
    .from(courses)
    .where(and(eq(courses.teacherId, teacherId), courseId ? eq(courses.id, courseId) : undefined))
    .orderBy(asc(courses.endsAt), asc(courses.id));
}

/** Row lock: course changes (patch, start, card edits) run one at a time. */
export async function lockCourse(db: DbOrTx, id: string) {
  const [row] = await db.select().from(courses).where(eq(courses.id, id)).for('update');
  return row ?? null;
}

export async function updateCourse(db: DbOrTx, id: string, set: Partial<typeof courses.$inferInsert>) {
  return (await db.update(courses).set(set).where(eq(courses.id, id)).returning())[0]!;
}

/** Draft course and everything under it (decision 0017: removed students too). */
export async function deleteCourseCascade(db: DbOrTx, id: string): Promise<void> {
  await db.delete(enrollments).where(eq(enrollments.courseId, id));
  await db.delete(flashcards).where(eq(flashcards.courseId, id));
  await db.delete(courses).where(eq(courses.id, id));
}
