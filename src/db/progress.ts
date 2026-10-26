import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { presentEnrollment } from './enrollments.js';
import { cardStates, courses, enrollments, flashcards, reviews } from './schema.js';

// Grouped reads behind the progress endpoints (rest-api.md "Progress"): one query per fact, not one per student.

export async function learnedByUser(db: DbOrTx, courseId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ userId: cardStates.userId, n: sql<number>`count(*)::int` })
    .from(cardStates)
    .innerJoin(flashcards, eq(flashcards.id, cardStates.flashcardId))
    .where(and(eq(flashcards.courseId, courseId), isNotNull(cardStates.learnedAt)))
    .groupBy(cardStates.userId);
  return new Map(rows.map((r) => [r.userId, r.n]));
}

/** `sent_at` of each student's open card in the course. */
export async function waitingSinceByUser(db: DbOrTx, courseId: string): Promise<Map<string, Date>> {
  const rows = await db
    .select({ userId: cardStates.userId, sentAt: cardStates.sentAt })
    .from(cardStates)
    .innerJoin(flashcards, eq(flashcards.id, cardStates.flashcardId))
    .where(and(eq(flashcards.courseId, courseId), isNotNull(cardStates.sentAt)));
  return new Map(rows.map((r) => [r.userId, r.sentAt!]));
}

/** Every card of the course with the student's state (if any) and the result of the latest review. */
export async function studentCards(db: DbOrTx, courseId: string, userId: string) {
  const lastCorrect = sql<boolean | null>`(select ${reviews.isCorrect} from ${reviews} where ${reviews.userId} = ${userId} and ${reviews.flashcardId} = ${flashcards.id} order by ${reviews.reviewedAt} desc limit 1)`;
  return db
    .select({
      flashcardId: flashcards.id,
      question: flashcards.question,
      learnedAt: cardStates.learnedAt,
      correctStreak: cardStates.correctStreak,
      due: cardStates.due,
      lastAnswerCorrect: lastCorrect,
    })
    .from(flashcards)
    .leftJoin(cardStates, and(eq(cardStates.flashcardId, flashcards.id), eq(cardStates.userId, userId)))
    .where(eq(flashcards.courseId, courseId))
    .orderBy(asc(flashcards.position));
}

/** Present enrollments of one student with their courses (`GET /users/:userId/courses`). */
export const coursesOfStudent = (db: DbOrTx, userId: string) =>
  db
    .select({ course: courses, enrollment: enrollments })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(and(eq(enrollments.userId, userId), presentEnrollment))
    .orderBy(asc(courses.endsAt), desc(courses.id));
