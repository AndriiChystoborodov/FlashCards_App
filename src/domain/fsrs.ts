import { fsrs, generatorParameters, type FSRS } from 'ts-fsrs';

// Whole-day steps: we send a card at most once a day (decision 0003).
export const fsrsParams = generatorParameters({
  enable_fuzz: false,
  learning_steps: ['1d'],
  relearning_steps: ['1d'],
});
export const defaultScheduler: FSRS = fsrs(fsrsParams);
export const LEARNED_STREAK = 2;
export const MIN_RETENTION_DAYS = 7; // decision 0015
