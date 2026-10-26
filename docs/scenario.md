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
4. section 1, seeded directly (REST and MCP come later): active course "Security basics" ending Friday 16 January 23:59 Zurich, 10 cards (3 assessment), Ann and Bea enrolled with Slack ids
5. section 1: `sendFirstCards` posts A1 to Ann and Bea at once; a second call sends nothing
6. section 2: Ann answers A1 right + Easy at 14:00. Expects an `easy` review, `scheduled_days` 8, streak 1, A2 posted
7. section 2: A2 right + Medium at 14:03. Expects `scheduled_days` 2, `due` Wednesday 14:03, A3 posted
8. section 2: A3 "Don't know" at 14:05, the last assessment card. Expects score 33.33, not exempt, only A1 learned, A3 `scheduled_days` 1 and stability 0.21, and card-1 posted as a new card (quota 1)
9. section 6: a second click on A3. Expects `not_open`, still one review, `assessment_done_at` unchanged
10. section 2: Bea answers all three right + Easy. Expects `exempt`, score 100, the "already know" message, no card open, nothing sent later
11. section 3: card-1 Monday 14:06 Medium. Expects `scheduled_days` 2, streak 1, `due` Wednesday 14:06, no second new card (quota used)
12. section 3: Tuesday 09:00: A3 is sent first (due Tuesday 14:05), answered Medium (`scheduled_days` 2, stability 1.89); card-2 is introduced and answered; no third card
13. section 3: Wednesday 09:00: A2 (due 14:03) before card-1 (due 14:06); card-1 at 09:15 Medium: FSRS `due` Sunday 18 January clamped to `2026-01-15T22:59:59.999Z`, `scheduled_days` 11, streak 2, not learned; then card-3 is introduced
14. section 3: Thursday 8 to Sunday 11 January: exactly one new card a day (card-4 to card-7); all 10 cards have a `card_states` row on Sunday
15. section 3: Monday 12 to Wednesday 14 January: reviews only, no card asked twice in a morning
16. section 3: Thursday 15 January: card-1 is asked again, gap 8 days, streak 3, `learned_at` that day; no card is asked twice (the clamp fix)
17. section 3: Friday 16 January: nothing is due
18. section 3: after `ends_at`: `finishEndedCourses` finishes the course, Ann is `completed` with `completed_progress` equal to her learned cards x 10 (the real run prints it: 4 of 10, 40), Bea stays `exempt`, the course-ended message is the last post, nothing more is sent

Each student's day is `sendNext` at 09:00 Zurich followed by Medium answers (the tick, 6b-1, will replace the direct call). The Slack side is `FakeSlack` (`src/slack/fake.ts`): it records posts and message replacements; the answer service and the scheduler are called directly. The walkthrough's sections 1 (REST/MCP), 3 (the tick itself), 4, 5 and the reminder edge cases are `pending` (Tasks 7 to 9, 6b-1, 6b-2).

`npm run db:up` waits for the compose healthcheck, so `npm run db:up && npm run db:reset` is safe on a fresh volume. The scenario uses `retain_dev`, `npm test` uses `retain_test` and `retain_reset_test`, so they can run at the same time.

## Known limits

- `advanceDays` counts a day as 24 hours (UTC milliseconds). Across a DST change the local time of day shifts by an hour, so the scheduler task (Task 6) must work with local-time days and must not rely on `advanceDays` for that.
- Running the reset script through a symlink prints nothing: the "run as main" check compares `argv[1]` with the file URL and does not resolve links. Run `npm run db:reset`.
- Step 1 resets `retain_dev`, so any data you keep there is wiped on every scenario run. Step 2 can only fail if the reset or a step in between leaves rows behind.
