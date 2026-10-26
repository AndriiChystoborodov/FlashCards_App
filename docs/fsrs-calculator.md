# FSRS usage and the card state calculator

Pure module in `src/domain/`: `fsrs.ts` (config, constants), `calculator.ts` (`applyAnswer`, `newCardState`, types, `MissingRatingError`), `assessment.ts` (`evaluateAssessment`). Built in Task 3 ([decision 0021](decisions/0021-task3-calculator-choices.md)). No database, Express or Slack imports. Unit tests next to it.

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
export const MIN_RETENTION_DAYS = 7;   // decision 0015
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

The scheduler is a default parameter ([decision 0009](decisions/0009-calculator-scheduler-default-param.md)). `now` is always passed in; the module never reads the clock. The calculator knows nothing about `ends_at` or timezones; clamping `due` is the answer service's job ([below](#clamping-due-in-the-answer-service)).

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
- `learnedAt = state.learnedAt ?? (isLearnedNow ? now : null)`, where `isLearnedNow` is defined in [the next section](#learned-and-the-retention-gap). Once set it is never cleared.
- A learned card is never sent again; the scheduler filters on `learnedAt`.
- `isCorrect` is `answer.chosenOption === card.correctOption`; `null` is never correct. The range of `chosenOption` is not validated here; services validate it against the card.

## Learned and the retention gap

[Decision 0015](decisions/0015-learned-needs-retention-gap.md). A card becomes learned when all three hold:

1. The answer is right with rating `medium` or `easy` (so the grade is Good or Easy).
2. The new `correctStreak >= LEARNED_STREAK` (2).
3. `state.last_review` exists and `now - state.last_review >= MIN_RETENTION_DAYS * 86_400_000` ms. This is the actual elapsed time between the two reviews, not the interval FSRS scheduled. A card never reviewed has no `last_review`, so the gap condition fails.

```ts
const gapMs = state.last_review ? now.getTime() - state.last_review.getTime() : 0;
const isLearnedNow = rightMediumOrEasy && newStreak >= LEARNED_STREAK && gapMs >= MIN_RETENTION_DAYS * 86_400_000;
```

If the streak is 2 or more and the gap is too short, the card stays unlearned and the streak keeps counting; the first later right Medium or Easy answer with a long enough gap makes it learned. Hard, wrong and Don't know reset the streak, as before.

### Where time is read

`applyAnswer` and `newCardState` take `now` as a parameter. The answer service gets it from the injectable clock (see [scheduler.md](scheduler.md#clock)), never from `new Date()`.

### Clamping `due` in the answer service

Not part of `applyAnswer` ([decision 0015](decisions/0015-learned-needs-retention-gap.md)). After `applyAnswer` returns, the answer service computes `dueNotAfter`, the end of the local day (student timezone) before `courses.ends_at`. If `state.due > dueNotAfter` and `dueNotAfter > endOfLocalDay(now)`, it sets `state.due = dueNotAfter` before saving. Other fields, including `scheduled_days`, stay as ts-fsrs returned them. When `dueNotAfter` is not after the end of today's local day (the answer is given on the last review day or later) nothing is clamped: a clamp to today would make the card due again at once and the scheduler would send it again, in a loop; a due after `ends_at` is never sent anyway. (Amended in Task 6, [decision 0026](decisions/0026-task6-scheduler-choices.md): the first rule was `dueNotAfter > now`.)

Built in `src/services/answer.ts` ([decision 0025](decisions/0025-task5-answer-service-choices.md)). `dueNotAfter` is `startOfLocalDay(local day of ends_at) - 1 ms` and `endOfLocalDay` is the last millisecond of the local day, both from `Intl` in `src/domain/localDay.ts` (pure, no Temporal; a day is 23 or 25 hours across DST, so it is never `ends_at - 24 h`). The student's timezone is `users.tz`; an invalid value falls back to `TENANT_TIMEZONE` with a warning. Example: `ends_at` Friday 16 January 23:59 Zurich gives `2026-01-15T22:59:59.999Z`, the end of Thursday.

A clamped card may be reviewed less than 7 days after the previous review and then cannot become learned at that review. This is accepted: progress shows it honestly.

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
- `evaluateAssessment` returns flags only. The answer service (Task 5, `src/services/answer.ts`) sets `learnedAt = now` on the passed assessment cards in the not-exempt case; the domain does not. It evaluates when the last assessment card is answered, using the first review of each assessment card, and also sets `assessment_done_at`, `assessment_score` and, when exempt, `status = 'exempt'`.
- `threshold` is not validated here (services/zod validate it). `score` is a percent 0 to 100.
- Assessment answers go through `applyAnswer` first, so their FSRS state and reviews are stored the same way.

## Worked example

See [walkthrough.md](walkthrough.md), with numbers from the real library. Reference table (`learning_steps` and `relearning_steps` `['1d']`, `enable_fuzz: false`, one send per day):

| sequence | scheduled_days after each answer |
| --- | --- |
| Good, Good | 2, 11 (stability 2.31, 10.96; difficulty 2.12, 2.11) |
| Good, Good, Good | 2, 11, 46 |
| Good, Good, Good, Again, Good, Good | 2, 11, 46, 1, 5, 12 |
| Easy, Easy | 8, 66 |
| Hard, Hard, Good | 1, 4, 12 (difficulty 5.11, 6.74, 6.73); each answer at the previous `due` (Hard's first `due` is 1.5 days away; the interval depends on when the answer comes) |
| Good, Again | 2, 1 (stability 2.31, 0.61; difficulty 2.12, 7.39) |
| Again | 1 (stability 0.21, difficulty 6.41) |
| Again, Good | 1, 2 |

Two Medium or Easy answers in a row are not enough any more: the last one must come 7 or more days after the previous review ([decision 0015](decisions/0015-learned-needs-retention-gap.md)). With `['1d']` steps, Good then Good (2 then 11 days) takes three sends: the second is at day 2 (not learned), the third comes after the 11-day interval. Easy then Easy (8 days) is learned at the second send. A card is usually sent 2 to 5 times. FSRS mostly sets the gaps.

## Tests

See [test-plan.md](test-plan.md#calculator). Property worth a test of its own: `applyAnswer` never mutates its input state.
