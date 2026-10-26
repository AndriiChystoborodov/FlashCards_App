import { and, eq, isNull } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { enrollments } from './schema.js';

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
