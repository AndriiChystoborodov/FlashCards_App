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

1. reset: database rebuilt and migrated
2. schema: every table of `src/db/schema.ts` exists and is empty
3. clock: advances by days

Walkthrough sections 1 to 6 are listed as `pending` (they need Tasks 5 to 9). No fake Slack yet: Task 5 calls the answer service directly, the fake Slack comes with Task 6.

`npm run db:up` waits for the compose healthcheck, so `npm run db:up && npm run db:reset` is safe on a fresh volume. The scenario uses `retain_dev`, `npm test` uses `retain_test` and `retain_reset_test`, so they can run at the same time.

## Known limits

- `advanceDays` counts a day as 24 hours (UTC milliseconds). Across a DST change the local time of day shifts by an hour, so the scheduler task (Task 6) must work with local-time days and must not rely on `advanceDays` for that.
- Running the reset script through a symlink prints nothing: the "run as main" check compares `argv[1]` with the file URL and does not resolve links. Run `npm run db:reset`.
- Step 1 resets `retain_dev`, so any data you keep there is wiped on every scenario run. Step 2 can only fail if the reset or a step in between leaves rows behind.
