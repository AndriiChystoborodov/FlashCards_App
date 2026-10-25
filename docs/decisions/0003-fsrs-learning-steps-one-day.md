# 0003. ts-fsrs with one-day learning steps

## Context

ts-fsrs defaults (`enable_short_term: true`, steps `1m, 10m`) return a new card or a card after Again in 1 to 10 minutes, in state Learning or Relearning. We send a card at most once a day, so the stored state would not match what happened.

## Options

- Keep defaults. Mismatched state.
- `enable_short_term: false`. Every answer gives whole days; Again gives 3 days on a fresh card.
- `learning_steps: ['1d'], relearning_steps: ['1d']`. Again gives 1 day: the card comes back the next day.

## Choice

Chosen by the user on 2026-10-24.

The third option: `learning_steps: ['1d']`, `relearning_steps: ['1d']`, `enable_fuzz: false` in config and tests.

## Why

After a wrong answer or "Don't know" the student sees the card again the next day, which suits a once-a-day sender. Whole-day steps keep the FSRS state honest. Measured with ts-fsrs 5.4.2: Good, Good, Good gives 2, 11, 46 days; Again on a fresh card gives 1 day; Again after Good gives 1 day. All cards stay in state `Review`. The values are one constant in `src/domain/fsrs.ts`; `enable_short_term: false` is the fallback if the next-day return proves too frequent. Fuzz may be turned on in production later.
