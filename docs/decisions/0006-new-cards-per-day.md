# 0006. New cards per day: computed from the remaining course days

## Context

AGENTS.md says new cards are introduced "N per day" but not how N is chosen.

## Options

- A fixed value per course (`courses.new_cards_per_day`, default 5 or 10), set by the teacher.
- A global constant.
- N computed every day from what is left to introduce and the days left.

## Choice

N is computed, not set. Chosen by the user on 2026-10-24. There is no teacher setting and no cap, so `courses.new_cards_per_day` does not exist.

```
remainingDays = local days from today through the local day of courses.ends_at, inclusive, at least 1
remainingNew  = non-assessment flashcards of the course with no card_states row for this student
quotaToday    = ceil((remainingNew + introducedToday) / remainingDays)
may introduce = quotaToday - introducedToday   (never below 0)
```

`introducedToday` counts `card_states.introduced_at` inside the student's local day, for non-assessment cards only (a clarification of 2026-10-25: without it the assessment cards sent on day one would use up the quota and the student would get no new card that day). It is added back so the quota stays the same all day and does not shrink after each send.

Assessment cards are not counted: they are all sent first, and the ones not passed continue as ordinary FSRS cards, not as new cards.

## Why

The course always finishes introducing every card by `ends_at`, and the pace evens out by itself: a late start or cards added mid-course raise N, a slow student (days skipped) is caught up gradually instead of at the end. It removes a setting the teacher would have to guess. The function is pure (inputs: counts and dates), so it is easy to test.

## Consequences

- A big course with a short window gives a high N and a heavy day. No cap means this is accepted; revisit if students complain.
- Due cards are not part of N, so reviews come on top of new cards.
- `ends_at` is required on `POST /courses` for this to work.
- On the last day `remainingDays` is 1, so all remaining new cards are introduced at once.
- A course with no new cards left gets N = 0.
- Cards added to an `active` course join the pool and the daily N recalculates. Students already `completed` do not get them ([decision 0011](0011-enrollment-completed.md)). Confirmed by the user on 2026-10-24.
