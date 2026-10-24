# 0004. A right answer without a rating is an error

## Context

A right answer is followed by the student choosing Hard / Medium / Easy. The calculator can receive `{ chosenOption: 1 }` without `rating`.

## Options

- Throw.
- Default to Medium (FSRS Good).
- Store a pending first click in the calculator.

## Choice

Throw `MissingRatingError`. Chosen by the user on 2026-10-24.

## Why

Slack's second step always supplies the rating, so a missing one is a caller bug. A default would invent an effort level and silently raise `correctStreak`. Storing the first click brings back state between clicks, which the Slack design avoids (the button value carries card id and option). Zod validates at the route and Slack handler first. A rating sent with a wrong or null answer is ignored, not an error, because a stale button should not crash a handler.
