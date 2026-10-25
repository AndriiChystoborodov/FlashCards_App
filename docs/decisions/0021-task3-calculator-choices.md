# 0021. Calculator (Roadmap Task 3): choices the docs left open

## Context

The Task 3 plan listed eight gaps between AGENTS.md, [fsrs-calculator.md](../fsrs-calculator.md) and the other docs. All answers below were given by the user on 2026-10-25 (source: the user, relayed in the Task 3 session).

## Choice

1. Files: `src/domain/fsrs.ts` (config, `LEARNED_STREAK`, `MIN_RETENTION_DAYS`), `calculator.ts` (`applyAnswer`, `newCardState`, types, `MissingRatingError`), `assessment.ts` (`evaluateAssessment`). Tests next to them.
2. `MissingRatingError extends Error`, message "A right answer needs a rating (hard, medium or easy)".
3. The domain owns `Rating3`. `src/slack/card.ts` keeps its own `Rating` until Task 8.
4. `evaluateAssessment` returns flags only; the answer service sets `learnedAt` for passed assessment cards in Task 5.
5. `assessment_score` is a percent 0 to 100; data-model.md reworded.
6. Hard, Hard, Good gives 1, 4, 12 days (difficulty 5.11, 6.74, 6.73), not 1, 3, 9; fsrs-calculator.md and walkthrough.md corrected. (Answers made at the previous `due`; Hard's first `due` is 1.5 days away.)
7. No doc change for `last_review` in `createEmptyCard` (the key is present, value `undefined`, as documented).
8. `evaluateAssessment` does not validate the threshold; a comment says services/zod do.

Extra tests approved: a rating on a "Don't know" answer, a late answer, `learnedAt` kept after a later right answer.

## Why

Chosen by the user so that Task 3 needs no decisions of its own.
