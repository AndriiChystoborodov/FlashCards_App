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
| `src/db/reset.ts` | `npm run db:reset`: creates `retain_dev` if missing, drops `public` and `drizzle`, applies `drizzle/` migrations. Refuses unless host is `localhost`/`127.0.0.1` and database is exactly `retain_dev` |
| `scripts/scenario.ts` | `npm run scenario`: steps run in order, `ok N name` or `FAIL N name: message` (exit 1 on the first failure), then the pending list |

## Steps now

1. reset: database rebuilt and migrated
2. schema: all six tables exist and are empty
3. clock: advances by days

Walkthrough sections 1 to 6 are listed as `pending` (they need Tasks 5 to 9). No fake Slack yet: Task 5 calls the answer service directly, the fake Slack comes with Task 6.
