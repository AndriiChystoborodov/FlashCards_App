# FSRS usage and the card state calculator

Pure module in `src/domain/`. No database, Express or Slack imports. Unit tests next to it.

Facts below were checked against `ts-fsrs@5.4.2` (FSRS-6, ESM, Node 20+) on 2026-10-24. Recheck the `Card` type on upgrade; the types, not this page, are authoritative.

## ts-fsrs in five lines

```ts
import { createEmptyCard, fsrs, generatorParameters, Rating, type Card, type FSRS } from 'ts-fsrs';

const scheduler = fsrs(generatorParameters({ enable_fuzz: false, learning_steps: ['1d'], relearning_steps: ['1d'] }));
const { card: next, log } = scheduler.next(card, now, Rating.Good); // input card is not mutated
```

- `next()` takes a `Grade` (`Again | Hard | Good | Easy`). `Rating.Manual` is a type error, which we want.
- `createEmptyCard(now)` returns 10 keys (`due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, learning_steps, state, last_review`); `last_review` is present with the value `undefined`. In the `Card` type it is optional (`last_review?: Date`).
- `Card.elapsed_days` is deprecated and removed in v6.

## Config ([decision 0003](decisions/0003-fsrs-learning-steps-one-day.md))

```ts
// src/domain/fsrs.ts
export const fsrsParams = generatorParameters({
  enable_fuzz: false,
  learning_steps: ['1d'],
  relearning_steps: ['1d'],
});
export const defaultScheduler: FSRS = fsrs(fsrsParams);
export const LEARNED_STREAK = 2;
```

With ts-fsrs defaults a new card or a card after Again returns in 1 to 10 minutes. We send at most once a day, so the state would be wrong. With whole-day steps (`['1d']`) every answer yields a whole-day interval, the card goes straight to `Review`, and a wrong answer brings it back the next day.

Production may turn fuzz on later to spread reviews. Tests always use `enable_fuzz: false`.

## CardState

```ts
export type CardState = Card & { correctStreak: number; learnedAt: Date | null };
```

`Card` comes from ts-fsrs, not copied, so an upgrade surfaces as a type error. Column mapping is in [data-model.md](data-model.md#card_states). `last_review` is `undefined` in code and null in the database; the repository maps it.

```ts
export const newCardState = (now: Date): CardState =>
  ({ ...createEmptyCard(now), correctStreak: 0, learnedAt: null });
```

## Types

```ts
export type Rating3 = 'hard' | 'medium' | 'easy';
export type Answer = { chosenOption: number | null; rating?: Rating3 };
export type Review = { chosenOption: number | null; isCorrect: boolean; rating: Rating3 | null; reviewedAt: Date };

export function applyAnswer(
  card: { correctOption: number },   // only what the rule needs
  state: CardState,
  answer: Answer,
  now: Date,
  scheduler: FSRS = defaultScheduler,
): { state: CardState; review: Review };
```

The scheduler is a default parameter ([decision 0009](decisions/0009-calculator-scheduler-default-param.md)). `now` is always passed in; the module never reads the clock.

## Rules

| answer | FSRS grade | `correctStreak` | `review.rating` |
| --- | --- | --- | --- |
| `null` (Don't know) | Again | 0 | null |
| wrong | Again | 0 | null |
| right + hard | Hard | 0 | `hard` |
| right + medium | Good | +1 | `medium` |
| right + easy | Easy | +1 | `easy` |

- Right answer with `rating` undefined throws `MissingRatingError` ([decision 0004](decisions/0004-right-answer-requires-rating.md)). Zod at the route or Slack handler checks first; the throw is the last guard.
- Wrong or null with a rating: the rating is ignored (`review.rating = null`). A stale button must not crash the handler.
- `learnedAt = state.learnedAt ?? (newStreak >= LEARNED_STREAK ? now : null)`. Once set it is never cleared.
- A learned card is never sent again; the scheduler filters on `learnedAt`.
- `isCorrect` is `answer.chosenOption === card.correctOption`; `null` is never correct. The range of `chosenOption` is not validated here; services validate it against the card.

## Assessment evaluation

Separate function in `src/domain/assessment.ts`, called once when the last assessment card is answered.

```ts
export function evaluateAssessment(
  reviews: Pick<Review, 'isCorrect' | 'rating'>[],   // one per assessment card
  threshold: number,                                  // percent, courses.assessment_pass_threshold
): { passedFlags: boolean[]; score: number | null; exempt: boolean };
```

- A card is passed only if `isCorrect && rating === 'easy'` ([decision 0005](decisions/0005-assessment-pass-easy-only.md)).
- `score = passed / total * 100`.
- Zero assessment cards: `evaluateAssessment([], t)` returns `{ passedFlags: [], score: null, exempt: false }`. The service still sets `enrollments.assessment_done_at = now` immediately (see [scheduler.md](scheduler.md#selecting-the-next-card)), leaves `assessment_score` null and continues in normal mode. Without this the assessment branch would never end.
- `exempt = score >= threshold`. Exempt: enrollment status `exempt`, progress 100, DM "you already know this material".
- Not exempt: passed assessment cards get `learnedAt = now` at once and are not sent again (exception to the streak rule). Other assessment cards continue with their FSRS state like normal cards, and all other cards are introduced N per day, with N computed daily ([decision 0006](decisions/0006-new-cards-per-day.md)).
- Assessment answers go through `applyAnswer` first, so their FSRS state and reviews are stored the same way.

## Worked example

See [walkthrough.md](walkthrough.md), with numbers from the real library. Reference table (`learning_steps` and `relearning_steps` `['1d']`, `enable_fuzz: false`, one send per day):

| sequence | scheduled_days after each answer |
| --- | --- |
| Good, Good | 2, 11 (stability 2.31, 10.96; difficulty 2.12, 2.11) |
| Good, Good, Good | 2, 11, 46 |
| Good, Good, Good, Again, Good, Good | 2, 11, 46, 1, 5, 12 |
| Easy, Easy | 8, 66 |
| Hard, Hard, Good | 1, 3, 9 (difficulty 5.11, 6.74, 6.73) |
| Good, Again | 2, 1 (stability 2.31, 0.61; difficulty 2.12, 7.39) |
| Again | 1 (stability 0.21, difficulty 6.41) |
| Again, Good | 1, 2 |

Because two Medium or Easy answers in a row end a card, a card is usually sent 2 to 5 times. FSRS mostly sets the first few gaps.

## Tests

See [test-plan.md](test-plan.md#calculator). Property worth a test of its own: `applyAnswer` never mutates its input state.
