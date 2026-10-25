import { createEmptyCard, Rating, type Card, type FSRS, type Grade } from 'ts-fsrs';
import { defaultScheduler, LEARNED_STREAK, MIN_RETENTION_DAYS } from './fsrs.js';

export type CardState = Card & { correctStreak: number; learnedAt: Date | null };
export type Rating3 = 'hard' | 'medium' | 'easy';
export type Answer = { chosenOption: number | null; rating?: Rating3 };
export type Review = {
  chosenOption: number | null;
  isCorrect: boolean;
  rating: Rating3 | null;
  reviewedAt: Date;
};

export class MissingRatingError extends Error {
  constructor() {
    super('A right answer needs a rating (hard, medium or easy)');
    this.name = 'MissingRatingError';
  }
}

const GRADES: Record<Rating3, Grade> = { hard: Rating.Hard, medium: Rating.Good, easy: Rating.Easy };
const DAY_MS = 86_400_000;

export const newCardState = (now: Date): CardState => ({
  ...createEmptyCard(now),
  correctStreak: 0,
  learnedAt: null,
});

export function applyAnswer(
  card: { correctOption: number },
  state: CardState,
  answer: Answer,
  now: Date,
  scheduler: FSRS = defaultScheduler,
): { state: CardState; review: Review } {
  const isCorrect = answer.chosenOption !== null && answer.chosenOption === card.correctOption;
  if (isCorrect && answer.rating === undefined) throw new MissingRatingError();

  const rating = isCorrect ? (answer.rating ?? null) : null;
  const grade = rating ? GRADES[rating] : Rating.Again;
  const { card: next } = scheduler.next(state, now, grade);

  const rightMediumOrEasy = rating === 'medium' || rating === 'easy';
  const correctStreak = rightMediumOrEasy ? state.correctStreak + 1 : 0;
  const gapMs = state.last_review ? now.getTime() - state.last_review.getTime() : 0;
  const isLearnedNow =
    rightMediumOrEasy && correctStreak >= LEARNED_STREAK && gapMs >= MIN_RETENTION_DAYS * DAY_MS;

  return {
    state: { ...next, correctStreak, learnedAt: state.learnedAt ?? (isLearnedNow ? now : null) },
    review: { chosenOption: answer.chosenOption, isCorrect, rating, reviewedAt: now },
  };
}
