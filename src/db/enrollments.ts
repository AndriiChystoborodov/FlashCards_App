import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { cardStates, courses, enrollments, flashcards, reviews, users } from './schema.js';

/** The one predicate for a present student (data-model.md "Derived values"); every enrollment query uses it. */
export const presentEnrollment = isNull(enrollments.removedAt);

export const listPresentEnrollments = (db: DbOrTx, courseId: string) =>
  db.select().from(enrollments).where(and(eq(enrollments.courseId, courseId), presentEnrollment));

/** The row whether or not it is removed: the caller checks `removedAt` (a removed student must get "no longer enrolled"). */
export async function getEnrollment(db: DbOrTx, courseId: string, userId: string) {
  const [row] = await db.select().from(enrollments).where(and(eq(enrollments.courseId, courseId), eq(enrollments.userId, userId)));
  return row ?? null;
}

export async function completeAssessment(
  db: DbOrTx,
  courseId: string,
  userId: string,
  r: { doneAt: Date; score: number | null; status: 'active' | 'exempt' },
): Promise<void> {
  await db
    .update(enrollments)
    .set({ assessmentDoneAt: r.doneAt, assessmentScore: r.score, status: r.status })
    .where(and(eq(enrollments.courseId, courseId), eq(enrollments.userId, userId)));
}

/** Locks the enrollment row until the transaction ends: sends for one student run one at a time, so there is never a second open card. */
export async function lockEnrollment(db: DbOrTx, courseId: string, userId: string) {
  const [row] = await db
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.courseId, courseId), eq(enrollments.userId, userId)))
    .for('update');
  return row ?? null;
}

/** `active` to `completed` (decision 0011). Returns false when the enrollment was not active (completed once only). */
export async function completeEnrollment(db: DbOrTx, courseId: string, userId: string, r: { at: Date; progress: number }): Promise<boolean> {
  const rows = await db
    .update(enrollments)
    .set({ status: 'completed', completedAt: r.at, completedProgress: r.progress })
    .where(and(eq(enrollments.courseId, courseId), eq(enrollments.userId, userId), eq(enrollments.status, 'active'), presentEnrollment))
    .returning({ userId: enrollments.userId });
  return rows.length > 0;
}

/** Every present `active` enrollment of an `active` course: who the tick looks at. */
export const listTickTargets = (db: DbOrTx, courseIds?: string[]) =>
  db
    .select({ userId: enrollments.userId, courseId: enrollments.courseId })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(and(eq(courses.status, 'active'), eq(enrollments.status, 'active'), presentEnrollment, courseIds ? inArray(enrollments.courseId, courseIds) : undefined));

export type EnrollmentRow = typeof enrollments.$inferSelect;

export const insertEnrollment = async (db: DbOrTx, courseId: string, userId: string, now: Date): Promise<boolean> =>
  (await db.insert(enrollments).values({ courseId, userId, status: 'active', enrolledAt: now }).onConflictDoNothing().returning({ u: enrollments.userId })).length > 0;

/** Clears `removed_at` (decision 0017); everything else is kept. */
export async function restoreEnrollment(db: DbOrTx, courseId: string, userId: string): Promise<boolean> {
  const rows = await db
    .update(enrollments)
    .set({ removedAt: null })
    .where(and(eq(enrollments.courseId, courseId), eq(enrollments.userId, userId), isNotNull(enrollments.removedAt)))
    .returning({ u: enrollments.userId });
  return rows.length > 0; // false when a parallel call restored it first
}

/** Returns false when the enrollment was already removed (the call is idempotent, `removed_at` does not move). */
export async function softRemoveEnrollment(db: DbOrTx, courseId: string, userId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(enrollments)
    .set({ removedAt: now })
    .where(and(eq(enrollments.courseId, courseId), eq(enrollments.userId, userId), presentEnrollment))
    .returning({ u: enrollments.userId });
  return rows.length > 0;
}

/** The retention cleanup (decision 0017) for one student of one course; Task 6b-2's daily job reuses it. */
export async function hardDeleteEnrollment(db: DbOrTx, courseId: string, userId: string): Promise<void> {
  const cardIds = db.select({ id: flashcards.id }).from(flashcards).where(eq(flashcards.courseId, courseId));
  await db.delete(reviews).where(and(eq(reviews.userId, userId), inArray(reviews.flashcardId, cardIds)));
  await db.delete(cardStates).where(and(eq(cardStates.userId, userId), inArray(cardStates.flashcardId, cardIds)));
  await db.delete(enrollments).where(and(eq(enrollments.courseId, courseId), eq(enrollments.userId, userId)));
}

export const listStudents = (db: DbOrTx, courseId: string) =>
  db
    .select({ enrollment: enrollments, user: users })
    .from(enrollments)
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(and(eq(enrollments.courseId, courseId), presentEnrollment))
    .orderBy(asc(enrollments.enrolledAt), asc(users.email));
