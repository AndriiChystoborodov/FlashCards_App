import { and, asc, eq } from 'drizzle-orm';
import type { Review } from '../domain/calculator.js';
import type { DbOrTx } from './client.js';
import { flashcards, reviews } from './schema.js';

export type ReviewRecord = Review & { userId: string; flashcardId: string; deliverySentAt: Date };

/** Returns false when this delivery already has a review (second click): the insert is ignored. */
export async function insertReview(db: DbOrTx, r: ReviewRecord): Promise<boolean> {
  const inserted = await db
    .insert(reviews)
    .values({
      userId: r.userId,
      flashcardId: r.flashcardId,
      chosenOption: r.chosenOption,
      isCorrect: r.isCorrect,
      rating: r.rating,
      reviewedAt: r.reviewedAt,
      deliverySentAt: r.deliverySentAt,
    })
    .onConflictDoNothing()
    .returning({ id: reviews.id });
  return inserted.length > 0;
}

/** The first review of each assessment card of the course the user has answered, in card position order (the assessment answers; later reviews are normal FSRS reviews). */
export async function listAssessmentReviews(
  db: DbOrTx,
  userId: string,
  courseId: string,
): Promise<{ flashcardId: string; isCorrect: boolean; rating: Review['rating'] }[]> {
  const rows = await db
    .select({ flashcardId: reviews.flashcardId, isCorrect: reviews.isCorrect, rating: reviews.rating, reviewedAt: reviews.reviewedAt })
    .from(reviews)
    .innerJoin(flashcards, eq(flashcards.id, reviews.flashcardId))
    .where(and(eq(reviews.userId, userId), eq(flashcards.courseId, courseId), eq(flashcards.isAssessment, true)))
    .orderBy(asc(flashcards.position), asc(reviews.reviewedAt));
  const first = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!first.has(r.flashcardId)) first.set(r.flashcardId, r);
  return [...first.values()].map(({ flashcardId, isCorrect, rating }) => ({ flashcardId, isCorrect, rating: rating as Review['rating'] }));
}
