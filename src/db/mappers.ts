import type { CardState } from '../domain/calculator.js';
import type { cardStates } from './schema.js';

type CardStateColumns = Pick<
  typeof cardStates.$inferInsert,
  | 'due' | 'stability' | 'difficulty' | 'elapsedDays' | 'scheduledDays' | 'learningSteps' | 'reps' | 'lapses'
  | 'state' | 'lastReview' | 'correctStreak' | 'learnedAt'
>;

// ts-fsrs `last_review` is `undefined` for a new card; the database stores NULL.
export function cardStateToColumns(s: CardState): Required<CardStateColumns> {
  return {
    due: s.due,
    stability: s.stability,
    difficulty: s.difficulty,
    elapsedDays: s.elapsed_days,
    scheduledDays: s.scheduled_days,
    learningSteps: s.learning_steps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state,
    lastReview: s.last_review ?? null,
    correctStreak: s.correctStreak,
    learnedAt: s.learnedAt,
  };
}

export function columnsToCardState(r: typeof cardStates.$inferSelect): CardState {
  const state: CardState = {
    due: r.due,
    stability: r.stability,
    difficulty: r.difficulty,
    elapsed_days: r.elapsedDays,
    scheduled_days: r.scheduledDays,
    learning_steps: r.learningSteps,
    reps: r.reps,
    lapses: r.lapses,
    state: r.state,
    correctStreak: r.correctStreak,
    learnedAt: r.learnedAt,
  };
  // NULL leaves `last_review` unset, as ts-fsrs does for a new card.
  if (r.lastReview !== null) state.last_review = r.lastReview;
  return state;
}
