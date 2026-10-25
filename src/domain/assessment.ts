import type { Review } from './calculator.js';

// threshold is a percent; services/zod validate its range, not this function.
export function evaluateAssessment(
  reviews: Pick<Review, 'isCorrect' | 'rating'>[],
  threshold: number,
): { passedFlags: boolean[]; score: number | null; exempt: boolean } {
  const passedFlags = reviews.map((r) => r.isCorrect && r.rating === 'easy');
  if (reviews.length === 0) return { passedFlags, score: null, exempt: false };
  const score = (passedFlags.filter(Boolean).length / reviews.length) * 100;
  return { passedFlags, score, exempt: score >= threshold };
}
