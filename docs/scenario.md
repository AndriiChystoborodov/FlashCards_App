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
| `src/api/testClient.ts` | `listen(deps)` (= `startServer` with `bindHost` `127.0.0.1`, port 0) and `call(token, method, path, body)` over `fetch`; used by the REST tests and the scenario |
| `scripts/scenario.ts` | `npm run scenario`: steps run in order, `ok N name` or `FAIL N name: message` (exit 1 on the first failure, plus a line saying how many steps passed), then the pending list and a final `N ok, M pending` line |

## Steps now

The clock starts on Monday 2026-01-05 at 09:00Z (10:00 Zurich), the date the walkthrough implies. Students have `tz` Europe/Zurich.

1. reset: database rebuilt and migrated
2. schema: every table of `src/db/schema.ts` exists and is empty
3. clock: advances by days, then goes back to the start
4. section 1 through REST (Task 7): Tom's token comes from `issueTeacherToken` (the function behind `npm run teacher:token`); a call without a token and one with a wrong token are 401; `POST /courses` ("Security basics", ends Friday 16 January 23:59 Zurich) gives a `draft` with threshold 90; `POST .../flashcards` adds 10 cards (3 assessment) at positions 1 to 10; `POST .../students` enrolls Ann and Bea (both `slack_matched`, the fake Slack directory knows them); `GET /courses/:id` shows `draft`, 10 cards, 3 assessment, 2 students; nothing has been posted
5. section 1 through REST: `POST .../start` gives `active` with `starts_at` Monday 09:00Z; 4 posts (the start message, then A1, for each student); both hold A1; a second start is 409 `course_not_draft` and posts nothing
6. section 2: Ann answers A1 right + Easy at 14:00. Expects an `easy` review, `scheduled_days` 8, streak 1, A2 posted
7. section 2: A2 right + Medium at 14:03. Expects `scheduled_days` 2, `due` Wednesday 14:03, A3 posted
8. section 2: A3 "Don't know" at 14:05, the last assessment card. Expects score 33.33, not exempt, only A1 learned, A3 `scheduled_days` 1 and stability 0.21, and card-1 posted as a new card (quota 1)
9. section 6: a second click on A3. Expects `not_open`, still one review, `assessment_done_at` unchanged
10. section 2: Bea answers all three right + Easy. Expects `exempt`, score 100, the "already know" message, no card open, nothing sent later
11. section 3: card-1 Monday 14:06 Medium. Expects `scheduled_days` 2, streak 1, `due` Wednesday 14:06, no second new card (quota used)
12. S19: Tuesday 08:59 Zurich: `runTick` sends nothing
13. section 3: Tuesday 09:00 `runTick`: sends A3 (due Tuesday 14:05) to Ann and nothing to Bea (exempt); A3 answered Medium (`scheduled_days` 2, stability 1.89); card-2 is introduced and answered; no third card
14. section 3: Wednesday 09:00 `runTick`: A2 (due 14:03) before card-1 (due 14:06); card-1 at 09:15 Medium: FSRS `due` Sunday 18 January clamped to `2026-01-15T22:59:59.999Z`, `scheduled_days` 11, streak 2, not learned; then card-3 is introduced
15. S12: Thursday 8 January 09:00 `runTick` with `failNextPost`: the pass counts one failure and the card stays claimed without `message_ts`; at 09:05 nothing is re-posted; at 09:10 the same delivery is posted again (`sent_at` unchanged, `message_ts` recorded)
16. section 3: Thursday 8 to Sunday 11 January: exactly one new card a day (card-4 to card-7); all 10 cards have a `card_states` row on Sunday
17. section 3: Monday 12 to Wednesday 14 January: reviews only, no card asked twice in a morning
18. section 3: Thursday 15 January: card-1 is asked again, gap 8 days, streak 3, `learned_at` that day; no card is asked twice (the clamp fix)
19. section 4 through REST (placed after Thursday 15 January): `GET .../progress` gives Ann `active`, learned = her learned cards (4 in the real run), total 10, progress = learned x 10, `assessment_done` true, `waiting_since` null; Bea `exempt` at 100; `class_progress` is their average (70); `GET .../students/:id/progress` lists 10 cards, card-1 `learned` with `correct_streak` 3 and `last_answer_correct` true
20. section 3: Friday 16 January: nothing is due
21. section 3: `runTick` after `ends_at`: the course is finished, Ann is `completed` with `completed_progress` equal to her learned cards x 10 (the real run prints it: 4 of 10, 40), Bea stays `exempt`, the course-ended message is the last post, a second tick does nothing
22. sections 5 and 6 through REST (second course "Phishing" on Saturday 17 January, 2 cards, Cy and Dee): `DELETE .../students/Dee` is 204, her open message is replaced with "expired" and her card voided; repeating it is 204 and replaces nothing; `student_count` is 1 and the progress list holds only Cy; `POST .../stop` gives `finished`, Cy `completed` with `completed_progress` 0, one new post (the ended message, 0%), Cy's open message replaced; a second stop is 409 `course_not_active`

23. Slack handlers (Task 8, fake client): a third course "Passwords", student Eve; the Bolt handlers (`registerHandlers` with a fake router) take her "Don't know" click: "Not quite" with the material, one review, the next assessment card posted; a second click is "already answered"; a Slack user nobody enrolled is "not enrolled"

Each of Ann's days is `runTick` at the controllable clock's 09:00 Zurich (08:00Z) followed by her Medium answers; the answers send the rest of the day's cards. The REST app runs in the scenario process on `127.0.0.1` and a random port (`createApp` + `listen` from `src/api/testClient.ts`, Node's `fetch`); it shares the controlled clock and the `FakeSlack`, so REST start, enroll and stop post into the same fake. The Slack side is `FakeSlack` (`src/slack/fake.ts`): it records posts and message replacements; the answer service and the scheduler are called directly. `startTick` is not used: the real interval is covered by one test in `src/services/tick.test.ts`, and Task 8 wires it into `src/index.ts`. Sections 1, 4, 5 and the removal part of 6 run through REST; their MCP versions (Task 9) and the reminder and cleanup edge cases (Task 6b-2) are `pending`.

`npm run db:up` waits for the compose healthcheck, so `npm run db:up && npm run db:reset` is safe on a fresh volume. The scenario uses `retain_dev`, `npm test` uses `retain_test` and `retain_reset_test`, so they can run at the same time.

## Known limits

- `advanceDays` counts a day as 24 hours (UTC milliseconds). Across a DST change the local time of day shifts by an hour, so the scheduler task (Task 6) must work with local-time days and must not rely on `advanceDays` for that.
- Running the reset script through a symlink prints nothing: the "run as main" check compares `argv[1]` with the file URL and does not resolve links. Run `npm run db:reset`.
- Step 1 resets `retain_dev`, so any data you keep there is wiped on every scenario run. Step 2 can only fail if the reset or a step in between leaves rows behind.
