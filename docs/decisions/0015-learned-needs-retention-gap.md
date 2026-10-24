# 0015. A card is learned only after a 7-day retention gap

## Context

Rule 6 in AGENTS.md says a card is learned when `correctStreak >= 2`. With our FSRS config ([decision 0003](0003-fsrs-learning-steps-one-day.md)) the first interval after a Medium answer is 2 days, so two Medium answers 2 days apart already ended the card. That proves short-term recall, not retention. Also, FSRS can schedule `due` after the course has ended, so the card would never be asked again.

## Options

- Keep `correctStreak >= 2` alone.
- Add a minimum gap: the right Medium or Easy answer that completes the streak must come at least `MIN_RETENTION_DAYS` after the previous review of that card.
- Require a longer streak (3 or more).

## Choice

The second option. Chosen by the user on 2026-10-24.

- A card is learned when `correctStreak >= LEARNED_STREAK` (2) **and** the current answer is right with Medium or Easy **and** `now - state.last_review >= MIN_RETENTION_DAYS` (7) days. The gap is the actual elapsed time between the two reviews, not the interval FSRS scheduled.
- `MIN_RETENTION_DAYS = 7` is a constant next to `LEARNED_STREAK` in `src/domain/fsrs.ts`.
- If the streak is 2 or more but the gap is shorter, the card is not learned. The streak keeps counting and the card is asked again; it is learned at the first later right Medium or Easy answer that satisfies the gap.
- `learnedAt` is set once and never cleared. A card passed in the assessment (right + Easy) is still learned at once (the existing exception).
- If FSRS schedules `due` after the course end, `due` is clamped to the day before `ends_at`, so the card still gets a last review. The caller passes the limit; the calculator stays free of timezones ([fsrs-calculator.md](../fsrs-calculator.md#learned-and-the-retention-gap)). No clamp when that day is not after `now`.

## Why

Two correct answers a day or two apart mostly measure short-term memory. A gap of a week approximates "still remembered after a week", which is what a course on policies or facts needs. Clamping keeps the last review inside the course, so the retention check can still happen.

## Consequences

- A card now needs two or three sends instead of two, and the course needs at least about 8 days after a card's introduction for it to be learned.
- Clamping can put the next review less than 7 days after the previous one; such a card cannot become learned at that review. This is accepted.
- The comparison is elapsed time (7 x 24 hours), not calendar days. A card answered at 14:00 and answered again 7 days later at 09:30 has a gap just under 7 days and is not learned yet. Raise this if it proves annoying.
- Cards introduced late in the course may stay unlearned at `ends_at`, and the progress shown to the teacher says so honestly ([decision 0011](0011-enrollment-completed.md)).

## Possible future changes (not for the MVP)

- Stop introducing new cards some days before `ends_at`, since a card introduced too late cannot reach the 7-day gap.
- Warn the teacher when a course is too short for its card count (the daily N from [decision 0006](0006-new-cards-per-day.md) and the 7-day gap together).
- Compare calendar days instead of elapsed hours for the gap.
