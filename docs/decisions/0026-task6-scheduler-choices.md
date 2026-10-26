# 0026. Scheduler (Roadmap Task 6): choices the docs left open

Source: the user approved the Task 6 plan (part 6a) and its answers, relayed by the session that started the build, 2026-10-26. Task 6 is built in three commits: **6a** core (this decision), **6b-1** daily tick, **6b-2** reminders, stale-claim recovery and cleanup. 6b-1 and 6b-2 wait for the user's approval.

## Context

[scheduler.md](../scheduler.md) says what `next()`, the send and the completion do, but not their shape, the Slack interface, who completes an enrollment, or what happens on a card's last review day. One of the open points turned out to be a real bug in the Task 5 clamp.

## Decisions

1. **Clamp amended.** The answer service clamps `due` only when `dueNotAfter > endOfLocalDay(now)` (before: `> now`). A card answered on the `dueNotAfter` day itself was clamped to the end of that day, was due again, and `next()` sent it again at once, without end: a calculator-only simulation of the walkthrough reached streak 902 for A3 on Thursday 15 January. Regression tests: the old rule fails both new tests (checked by temporarily restoring it). S51 is rewritten ([test-plan.md](../test-plan.md)); [fsrs-calculator.md](../fsrs-calculator.md#clamping-due-in-the-answer-service), scheduler.md and [0025](0025-task5-answer-service-choices.md) carry the amendment.
2. **Short courses: no intro cutoff.** The quota runs to `ends_at` ([0006](0006-new-cards-per-day.md)); late cards may stay unlearned and progress says so. The open question in scheduler.md stays as a future option list. Numbers for the walkthrough course (10 cards, 12 days, perfect Medium student):
   - A calculator-only simulation (`applyAnswer`, the quota formula and `endOfLocalDay`, no database, answers every morning at 09:00 Zurich) gave **4 of 10 learned** (A1, A2, card-1, card-2) with the fixed clamp. Without the fix it never ended.
   - The real scenario (`npm run scenario`, step 18: real Postgres, the scheduler and answer services, `FakeSlack`) gave **4 of 10 learned, `completed_progress` 40**. The two agree. The user's earlier estimate of "about 5" is not reproduced; the real number is 4.
3. **Reviews and re-enrollment (the open item of 0025).** Reviews do **not** survive a re-created enrollment, by design ([0017](0017-enrollment-soft-delete.md)):
   - Within `REMOVED_RETENTION_DAYS` the same enrollment row is restored (`removed_at` cleared): reviews, `card_states` and `assessment_done_at` stay, and the assessment is not run again.
   - The cleanup deletes the `reviews` and `card_states` of that student for the flashcards of that course and then the enrollment row, in one transaction. A new enrollment therefore has no reviews, so `listAssessmentReviews` sees nothing old, and the assessment cards come first.
   - Tests belong to 6b-2: after the cleanup no review or state remains for that course, other courses' data is kept, and a new enrollment starts with the assessment. No `enrolled_at` guard is added to `listAssessmentReviews`.
4. **Who completes.** `afterAnswer` (called after every answer) runs `completeIfLearned`; `finishCourse` / `finishEndedCourses` complete the rest at `ends_at` or on stop. `submitAnswer` stays as 0025 left it.

## Choices

| # | choice | why |
| --- | --- | --- |
| 1 | `SlackPort { postCard(to, CardMessage) -> {channel, ts}; replaceMessage(channel, ts, CardMessage); lookupEmail(email) -> {slackId, tz} \| null }` in `src/slack/port.ts`; text-only messages (DMs) are `CardMessage`s built with `textOnly` | the docs name three methods and no shapes; one post method keeps the port small |
| 2 | `FakeSlack` in `src/slack/fake.ts` records posts and replacements; `failNextPost` simulates an outage | service tests and the scenario need it |
| 3 | `sendNext` runs the guards, the selection and the claim in one transaction under `SELECT ... FOR UPDATE` on the enrollment row; the Slack call happens after the commit | one open card per student, no network call while holding a lock. scheduler.md names `FOR UPDATE SKIP LOCKED` for several instances; a row lock on the enrollment also serializes two callers in one process |
| 4 | `claimCard` is one `INSERT ... ON CONFLICT DO UPDATE SET sent_at = now WHERE sent_at IS NULL` | creates the row of a new card (`newCardState`, `introduced_at = now`) or claims an existing one atomically |
| 5 | Ties on `due` are ordered by `position` | deterministic |
| 6 | `remainingDays` is `localDaysThrough(tz, now, ends_at)`: local calendar days from today through the day of `ends_at`, from local y/m/d, at least 1 | DST safe; 12 for the walkthrough |
| 7 | `next()` returns none once `now >= ends_at`, before the tick completes the enrollment | closes the gap between `ends_at` and the tick |
| 8 | At `finishCourse` an open card's row is left as it is and its Slack message is replaced with "The course is over."; the click is refused as `course_over` by the answer service | no state change needed |
| 9 | A student without `slack_id` is skipped before the claim | no dead claim, nothing to retry |
| 10 | The zero-assessment completion (`assessment_done_at`, score null) runs inside `next()` as scheduler.md says, so `next()` is not a pure read in that case | S22 |
| 11 | When all assessment cards were sent but the assessment is not done, the picker returns none; `submitAnswer` owns the evaluation | the evaluation branch in scheduler.md's pseudo-code would be dead code |
| 12 | Course-wide loops (`sendFirstCards`, `finishCourse` notifications) are sequential and catch an error per student | one failure must not stop the class; no `Promise.all` ([scheduler.md](../scheduler.md#load)) |
| 13 | `studentTimezone` (`src/services/timezone.ts`) replaces the inline timezone fallback in `answer.ts`; same warning text | the scheduler needs the same rule |
| 14 | `sendNext` has no `gate` option (the plan listed one) | the tick (6b-1) checks the local hour before calling it |
| 15 | S45 (class progress without a removed student) moves to Task 7 with S20 | it needs the progress endpoint |

## S cases by commit

6a: S1, S3 and S4 (rest), S5 to S11, S15 to S17, S21 to S30, S34 (rest), S36, S38, S39 (course part: a removed enrollment is not completed), S42, S46, S53, plus first cards, the S51 regression and the lock race. 6b-1: S19, the tick calls `finishEndedCourses`, a repeated tick sends nothing new, S39 (tick part). 6b-2: S12, S18, S32, S33, S35, S43, S44, S47, S48, and the re-enrollment tests of decision 3. Task 7: S45 with S20. Rationale per case: S42 and S46 are `next()` selection; S12 is recovery driven by the tick; S47 is the cleanup marker.

Amendment ([0027](0027-task6b1-tick-choices.md)): S12 (stale-claim recovery) moved from 6b-2 to 6b-1; 6b-2 keeps the reminders and the cleanup.

## Hooks 6a leaves for 6b

- `sendNext` is the only place that claims and posts; 6b-2 adds a recovery path that re-posts a row with `sent_at` older than 10 minutes and no `message_ts` (the failure test shows the state).
- `SlackPort.replaceMessage` is in the port and used by `finishCourse`; reminders and "expired" use it.
- `finishEndedCourses(deps)` is what the tick calls at `ends_at`; `finishCourse(deps, courseId)` is what stop (Task 7) calls.
- Env: `TICK_MINUTES`, `REMINDER_AFTER_HOURS`, `MAX_REMINDERS` are added to the env schema and `.env.example` in 6b; 6a added none.
- `card_states.reminded_at`, `reminder_count`, `message_channel`, `message_ts` already exist; no migration is needed.

## Known limits

- Late cards may stay unlearned (decision 2).
- A failed Slack post after the claim leaves the card open, blocking that student, until 6b-2 re-sends it.
- Test isolation: tests share the test database. The only test that calls `finishEndedCourses` gives its course an `ends_at` in the year 2000 so no other test's course is finished; the other completion tests use `finishCourse` with a course id.

- `setCardMessage` runs after the claim's commit; if `finishCourse` commits in between, that one open card's message is not replaced (a late click still gets `course_over`).
- `claimCard` clears `message_channel`/`message_ts` of the previous delivery, and an unanswered voided assessment card is picked again (both found by the diff review).

## Verification (what was run against what)

- Real Postgres (`retain_test`, `retain_dev`): `npm test` (219 tests), `npm run scenario` (18 steps), and the lock race (below).
- Lock race, real Postgres, the two S11 tests with and without `FOR UPDATE`. With the lock: 3 runs of 80 rounds x 10 concurrent `sendNext` calls (each run covers both shapes: a fresh course, and four due cards) all passed, always one open card and one post. Without the lock: 2 of 2 runs failed in both tests ("expected 1 sent, got 2": two open cards). With 4 callers and 15 rounds the unlocked version passed 3 of 3 runs, so the window is narrow: a second caller reads "no open card", the first commits, and the second then picks a different card. The committed test uses 30 rounds x 8 callers.
- Direct calculator calls only, no database: the 4-of-10 simulation.
- Fake Slack only: all message content checks. Nothing here was run against real Slack.
