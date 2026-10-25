import type { Review } from '../domain/calculator.js';
import type { DbOrTx } from './client.js';
import { reviews } from './schema.js';

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
