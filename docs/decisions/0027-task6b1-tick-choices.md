# 0027. Daily tick and stale-claim recovery (Roadmap Task 6b-1): choices

Source: the user approved the 6b-1 plan with two changes and two additions, relayed by the session that started the build, 2026-10-26. Follows [0026](0026-task6-scheduler-choices.md).

## Context

[scheduler.md](../scheduler.md) describes the tick as a `setInterval` in the API process that starts each student's day, and says a claim older than 10 minutes without `message_ts` is re-sent. Reminders and the 14-day cleanup are Task 6b-2.

## Deviations from the original scheduler.md lines

1. **Stale-claim recovery is in 6b-1** (it was assigned to 6b-2): it is a few lines on top of the tick and needs no reminder columns.
2. **The tick is not started from `src/index.ts`.** There is no real Slack adapter for `SlackPort` until Task 8; starting the tick in the dev server would mark cards as sent through a fake. `runTick` and `startTick` are built and tested; Task 8's row in [implementation-plan.md](../implementation-plan.md) now says `index.ts` calls `startTick` with the real adapter. The scenario calls `runTick` with the controllable clock and the `FakeSlack`.
3. **The claim text** in scheduler.md ("a single `UPDATE ... WHERE sent_at IS NULL`", `SKIP LOCKED`) is replaced by what 0026 built: `INSERT ... ON CONFLICT DO UPDATE ... WHERE sent_at IS NULL` under `FOR UPDATE` on the enrollment row.

## Choices

| # | choice | why |
| --- | --- | --- |
| 1 | `runTick(deps, cfg)` does one pass: `finishEndedCourses`, then per present `active` enrollment of an `active` course: stale-claim re-post, or `sendNext` from the student's local `SEND_HOUR` | scheduler.md "Tick" |
| 2 | Recovery is not gated by `SEND_HOUR`; the threshold is a constant (10 minutes, `STALE_CLAIM_MINUTES`) in `cfg`, not an env var | the send was already started; the doc has no config row for it |
| 3 | With a 15-minute tick a stale claim is re-posted 10 to 25 minutes after it was made | follows from the two numbers |
| 4 | `resendStaleClaim` posts the same delivery: `sent_at` is unchanged, `message_channel`/`message_ts` are recorded; the post code is shared with `sendNext` | an answer to the re-posted message closes the same delivery |
| 5 | `startTick` guards with a `running` flag: an interval that fires while a pass is running is skipped and counted (`stats.skipped`); `stats.runs` counts started passes; `stop()` clears the interval; the timer is `unref`'d; the first pass is one interval after the start; a thrown pass is logged and the flag reset | no overlapping passes |
| 6 | Students are handled one after another; an error is logged, counted in `failed` and the pass goes on | one failure must not stop the class; sequential for Slack's rate limit |
| 7 | `TICK_MINUTES` (default 15, positive integer) is added to the env schema and `.env.example`; `startTick` takes `intervalMs`, so the caller converts | the Config table in scheduler.md already lists it |
| 8 | `localHour(tz, date)` in `localDay.ts` returns 0 to 23 from `Intl` (hourCycle h23) | midnight must be 0, not 24 |
| 9 | `TickConfig.courseIds` limits a pass to given courses | the test database is shared, and a pass finishes every ended active course; tests pass their own course so they cannot finish another test's course |
| 10 | The `startTick` test uses one real 20 ms interval with a Slack fake that blocks, asserts only counts (skipped, runs, posts), polls with a 3 s limit and waits 150 ms margins; no fake-timer test | a fake-timer test would skip passes, because a pass does real database work that fake timers do not advance |

## Consequences

- A student whose Slack post fails stays blocked for 10 to 25 minutes, then the tick re-posts the card. If the post succeeded but recording `message_ts` failed, the student can get the card twice; accepted (scheduler.md).
- The cleanup marker and the reminders are not here (6b-2).

## Verification

See the Task 6b-1 report: the tick tests and `npm run scenario` ran on the real local Postgres with the fake Slack; `localHour` tests are pure; the `startTick` test used a real 20 ms interval. Not verified: a real Slack adapter, `startTick` running for hours, time zones other than Zurich, Kolkata, New York and Auckland.
