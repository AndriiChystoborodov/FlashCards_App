# 0030. A visual report of the scenario run

Source: the user, 2026-10-26.

## Context

`npm run scenario` prints `ok` lines. To show the 12-day course to people who do not read logs, the user wants a picture of the same run.

## Choice

1. The scenario records a trace while it runs and writes `reports/scenario.json` after all steps pass. It does not add, change or reorder any step or assertion (before and after: `23 ok, 2 pending`). `reports/` is in `.gitignore`.
2. The trace comes from the run itself: each answer is recorded in `reply()` (card, sent time, answer time, rating, correct, the new `due`, whether `due` was clamped) and the rest is read from the database at the end (`card_states.introduced_at`, `learned_at`, the enrollments). The per-day grouping is `buildTrace` in `src/report/trace.ts`, in Ann's time zone.
3. `npm run scenario:report` (`scripts/scenario-report.ts`) renders `reports/scenario.html` with `renderReport` (`src/report/render.ts`): plain inline SVG, no JavaScript, no external request, no dependency. It exits 1 with the missing file and "run npm run scenario" if the trace is missing or malformed (zod).
4. Marks differ by shape and letter, not colour: sent triangle, circle with H/M/E, diamond with X (wrong or "Don't know"), dashed line (waiting), black C tag (due clamped), L box (learned). Text is large, black on white.
5. A failed run deletes the old trace first, so a stale picture is never shown as the result of a failed run.

## Why

The trace is a by-product of what already asserts, so the picture cannot drift from the test. Splitting trace, renderer and script keeps the scenario change small and lets the renderer be unit tested without a database. One dependency-free HTML file can be opened offline and projected.
