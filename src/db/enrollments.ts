import { and, eq, isNull } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { enrollments } from './schema.js';

/** The one predicate for a present student (data-model.md "Derived values"); every enrollment query uses it. */
export const presentEnrollment = isNull(enrollments.removedAt);

export const listPresentEnrollments = (db: DbOrTx, courseId: string) =>
  db.select().from(enrollments).where(and(eq(enrollments.courseId, courseId), presentEnrollment));
