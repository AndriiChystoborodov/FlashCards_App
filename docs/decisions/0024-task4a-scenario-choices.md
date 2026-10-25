# 0024. Task 4a: scenario script, reset script and clock

Source: the user, answering the implementer's 14 questions on Task 4a (the docs left these open), 2026-10-25.

## Context

[implementation-plan.md](../implementation-plan.md) (Task 4a) says what 4a delivers (reset script, clock, skeleton) but not names, places, formats or the target database.

## Choice

1. Task 4a sits right after Task 4 and keeps the name "4a".
2. The clock is `src/clock.ts`: `interface Clock { now(): Date }`, `systemClock`, and `createControlledClock(start)` with `set` and `advanceDays` for the scenario.
3. The reset script is `src/db/reset.ts`, run as `npm run db:reset`.
4. "Clean" = drop the `public` and `drizzle` schemas, recreate `public`, apply the migrations in `drizzle/`.
5. `DATABASE_URL` is the dev database `retain_dev`; `TEST_DATABASE_URL` is `retain_test`. The reset script creates `retain_dev` if missing, by connecting to the maintenance database `postgres` (compose init scripts only run on the first volume init). The scenario never touches `retain_test`, so it can run beside `npm test`. This replaces the earlier "both URLs may be the same" note.
6. Safety guard: the reset refuses unless the host is `localhost` or `127.0.0.1` and the database name is exactly `retain_dev`. Tested in `src/db/reset.test.ts`.
7. The scenario and reset read `DATABASE_URL` through `src/config/env.ts` (so the Slack variables must be set, as for every entry point).
8. The scenario is `scripts/scenario.ts`, run as `npm run scenario`; `tsconfig.json` includes `scripts`.
9. Steps are `{ name, run }`, run in order with `node:assert`; output is `ok N name` or `FAIL N name: message` and the exit code is 1 on the first failure.
10. No fake Slack in 4a. In Task 5 the scenario can call the answer service directly; the fake Slack comes in Task 6.
11. The skeleton has three real steps (reset, six empty tables, clock advance); walkthrough sections 1 to 6 are printed as `pending` with the task that unlocks them.
12. Tests: `src/clock.test.ts`, `src/db/reset.test.ts` (guard refusals, reset twice, wipes data). No new ids in test-plan.md.
13. These choices are this decision (0024).
14. The doc is [scenario.md](../scenario.md).

## Why

Smallest set that meets the "done when" in the plan: `npm run scenario` passes the steps possible now, and the reset rebuilds an empty database. A separate dev database keeps the scenario from clashing with the tests, which share `retain_test` without truncating.
