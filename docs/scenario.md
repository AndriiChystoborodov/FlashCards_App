# End-to-end scenario script (Task 4a)

Follows [walkthrough.md](walkthrough.md) against local Postgres. Choices: [decision 0024](decisions/0024-task4a-scenario-choices.md).

## Run

```bash
npm run db:up
DATABASE_URL=postgres://retain:retain@localhost:5433/retain_dev npm run db:reset
npm run scenario
```

(`DATABASE_URL` normally comes from `.env`; see `.env.example`.) Run it after every task and extend it.

## Parts

| file | what |
| --- | --- |
| `src/clock.ts` | `Clock { now(): Date }`, `systemClock`, `createControlledClock` (`set`, `advanceDays`). Services, the scheduler and the tick read time only from a `Clock` ([scheduler.md](scheduler.md#clock)) |
| `src/db/reset.ts` | `npm run db:reset`: creates `retain_dev` if missing, drops `public` and `drizzle`, applies `drizzle/` migrations. Refuses unless host is `localhost`/`127.0.0.1`, the URL has no query parameters, and the database is exactly `retain_dev` or `retain_reset_test` (the reset test's own throwaway database, created and dropped by the test) |
| `scripts/scenario.ts` | `npm run scenario`: steps run in order, `ok N name` or `FAIL N name: message` (exit 1 on the first failure, plus a line saying how many steps passed), then the pending list and a final `N ok, M pending` line |

## Steps now

The clock starts on Monday 2026-01-05 at 09:00Z (10:00 Zurich), the date the walkthrough implies. Students have `tz` Europe/Zurich.

1. reset: database rebuilt and migrated
2. schema: every table of `src/db/schema.ts` exists and is empty
3. clock: advances by days, then goes back to the start
4. section 1, seeded directly (REST and MCP come later): active course "Security basics" ending Friday 16 January 23:59 Zurich, 10 cards (3 assessment), Ann and Bea enrolled. Expects 3 assessment cards and Ann `active` with `assessment_done_at` null
5. section 2: Ann answers A1 right + Easy at 14:00. Expects an `easy` review, `sent_at` null, `scheduled_days` 8, streak 1, no evaluation yet
6. section 2: A2 right + Medium at 14:03. Expects `scheduled_days` 2, streak 1, `due` Wednesday 14:03
7. section 2: A3 "Don't know" at 14:05, the last assessment card. Expects score 33.33, not exempt, `assessment_done_at` 14:05, status `active`, only A1 with `learned_at`, A3 `scheduled_days` 1 and stability 0.21
8. section 6: a second click on A3. Expects `not_open`, still one review, `assessment_done_at` unchanged
9. section 2: Bea answers all three right + Easy. Expects status `exempt`, score 100, no card left open
10. section 3, answer part: card-1 Monday 14:06 Medium. Expects `scheduled_days` 2, streak 1, `due` Wednesday 14:06
11. section 3, answer part: card-1 Wednesday 09:15 Medium. Expects FSRS `due` Sunday 18 January clamped to `2026-01-15T22:59:59.999Z`, `scheduled_days` still 11, streak 2, not learned
12. section 3, answer part: card-1 Thursday 15 January 09:20 Medium. Expects streak 3 and `learned_at` that moment (gap 8 days)

A step stands in for the scheduler's send by writing the `card_states` row with `sent_at` (Task 6 replaces that). The walkthrough sections 1, 3 (tick, quota), 4, 5 and the reminder edge cases are listed as `pending` (Tasks 6 to 9). No fake Slack yet: Task 5 calls the answer service directly, the fake Slack comes with Task 6.

`npm run db:up` waits for the compose healthcheck, so `npm run db:up && npm run db:reset` is safe on a fresh volume. The scenario uses `retain_dev`, `npm test` uses `retain_test` and `retain_reset_test`, so they can run at the same time.

## Known limits

- `advanceDays` counts a day as 24 hours (UTC milliseconds). Across a DST change the local time of day shifts by an hour, so the scheduler task (Task 6) must work with local-time days and must not rely on `advanceDays` for that.
- Running the reset script through a symlink prints nothing: the "run as main" check compares `argv[1]` with the file URL and does not resolve links. Run `npm run db:reset`.
- Step 1 resets `retain_dev`, so any data you keep there is wiped on every scenario run. Step 2 can only fail if the reset or a step in between leaves rows behind.
