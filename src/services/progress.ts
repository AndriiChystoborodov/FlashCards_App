import type { Db } from '../db/client.js';
import { getEnrollment, listStudents, type EnrollmentRow } from '../db/enrollments.js';
import { learnedByUser, studentCards, waitingSinceByUser } from '../db/progress.js';
import { countCards } from '../db/selection.js';
import { ServiceError } from './errors.js';
import { getUser } from '../db/users.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** data-model.md "Derived values": completed keeps the frozen value, exempt is 100, active is learned over total. */
export function progressValue(e: Pick<EnrollmentRow, 'status' | 'completedProgress'>, learned: number, total: number): number {
  if (e.status === 'completed') return round2(e.completedProgress ?? 0);
  if (e.status === 'exempt') return 100;
  return total === 0 ? 0 : round2((learned / total) * 100);
}

export interface StudentProgress {
  studentId: string;
  name: string;
  status: string;
  progress: number;
  learned: number;
  total: number;
  assessmentDone: boolean;
  waitingSince: Date | null;
}

export async function courseProgress(db: Db, courseId: string): Promise<{ classProgress: number; students: StudentProgress[] }> {
  const [rows, learned, waiting, total] = await Promise.all([listStudents(db, courseId), learnedByUser(db, courseId), waitingSinceByUser(db, courseId), countCards(db, courseId)]);
  const students = rows.map(({ enrollment: e, user }) => {
    const n = learned.get(user.id) ?? 0;
    return {
      studentId: user.id,
      name: user.fullName,
      status: e.status,
      progress: progressValue(e, n, total),
      learned: n,
      total,
      assessmentDone: e.assessmentDoneAt !== null,
      waitingSince: waiting.get(user.id) ?? null,
    };
  });
  const classProgress = students.length === 0 ? 0 : round2(students.reduce((a, s) => a + s.progress, 0) / students.length);
  return { classProgress, students };
}

/** A removed or unknown student is `not_found` (rest-api.md: removed students are not listed). */
export async function studentProgress(db: Db, courseId: string, userId: string) {
  const e = await getEnrollment(db, courseId, userId);
  const user = e && !e.removedAt ? await getUser(db, userId) : null;
  if (!e || !user) throw new ServiceError('not_found', 'Student not found in this course.');
  const [learned, waiting, total, cards] = await Promise.all([learnedByUser(db, courseId), waitingSinceByUser(db, courseId), countCards(db, courseId), studentCards(db, courseId, userId)]);
  const n = learned.get(userId) ?? 0;
  const student: StudentProgress = {
    studentId: userId, name: user.fullName, status: e.status, progress: progressValue(e, n, total), learned: n, total,
    assessmentDone: e.assessmentDoneAt !== null, waitingSince: waiting.get(userId) ?? null,
  };
  return { student, cards };
}
