# 0025. Answer service (Roadmap Task 5): choices the docs left open

Source: the user approved the Task 5 plan and answered its three questions (relayed by the session that started Task 5), 2026-10-26. The choices in the second table were proposed in the plan and approved with it.

## Context

[scheduler.md](../scheduler.md#answer-path), [fsrs-calculator.md](../fsrs-calculator.md#clamping-due-in-the-answer-service) and [test-plan.md](../test-plan.md) say what the answer service does but not its shape, its error codes or how the end of a local day is computed.

## Answers to the plan's questions

1. Task 5 tests only the service part of S3, S10 and S34. The Task 6 and 7 rows add the rest (next card sent, no cards for an exempt student, progress 100). The split is written into [test-plan.md](../test-plan.md#exit-criteria-per-roadmap-task) and [implementation-plan.md](../implementation-plan.md).
2. Completing an enrollment after the last learned card is Task 6 (S16). The answer service returns the new state and does not set `completed`. Until Task 6 a student at 100% stays `active`.
3. The scenario clock starts at `2026-01-05T09:00:00Z` (Monday 10:00 Zurich), the date the walkthrough implies (the course ends Friday 16 January). The old start, 12 January, did not match the walkthrough's dates. The clock step in `scripts/scenario.ts` and [scenario.md](../scenario.md) are fixed.

## Choices

| # | choice | why |
| --- | --- | --- |
| 1 | `submitAnswer(deps: { db, clock, tenantTimezone }, input)` in `src/services/answer.ts`; result is `answered`, `rejected` with a reason, or `duplicate` | the repositories are plain functions too; no factory needed; Task 8 maps the result |
| 2 | Slack's first click (a right answer shows Hard / Medium / Easy, H5, H10) is not in the service; Task 8 adds it | it stores nothing; Task 5's scope is the write path |
| 3 | `messageTs` is optional and compared only when both it and `card_states.message_ts` exist | the dev REST route has no Slack message |
| 4 | Check order: card, enrollment and course, `removed_at`, enrollment or course not `active`, `sent_at`, `messageTs`, option range, then the writes | a removed student's voided card also has `sent_at` null, so "removed" must come before "not open" (S41) |
| 5 | The review insert is the first write; a repeat returns `duplicate` and nothing else is written | the unique delivery key is the lock ([integration.md](../slack/integration.md#identity)) |
| 6 | `now` is read once per call from the `Clock` | every stamp of one answer is equal |
| 7 | The assessment is evaluated when the answered card is an assessment card, `assessment_done_at` is null and every assessment card of the course has a review | zero assessment cards stays in `next()` (Task 6, S22, A8) |
| 8 | The evaluation input is the first review of each assessment card, in position order (`listAssessmentReviews`) | later reviews are normal FSRS reviews; keeps A9 order |
| 9 | The result carries `correctOption` and `card.materialUrl ?? course.materialUrl` | the REST response and the Slack outcome need them |
| 10 | A `chosenOption` that is not an integer inside the card's options throws `InvalidOptionError` | the calculator does not validate it (fsrs-calculator.md) |
| 11 | An invalid `users.tz` falls back to `TENANT_TIMEZONE` with a `console.warn` naming the user id and the bad value; a null `tz` falls back silently | an answer must not fail on a bad Slack value |
| 12 | No row lock on the enrollment | a student has one open card and the review key already serializes two clicks |

Added during the implementation:

| # | choice | why |
| --- | --- | --- |
| 13 | An answer clears `sent_at`, `reminded_at` and `reminder_count`, and keeps `message_channel` and `message_ts` | the delivery is closed; the next send overwrites the message fields; a late click is "not open" because `sent_at` is null |
| 14 | Exempt: no `learned_at` is set on the passed assessment cards | fsrs-calculator.md sets it only in the not-exempt branch; exempt progress is 100 by status |
| 15 | `isValidTimezone`, `endOfLocalDay` and `dueNotAfter` live in `src/domain/localDay.ts` (pure, Intl only) | Task 6 reuses `endOfLocalDay` for "due today" |
| 16 | `endOfLocalDay` is the last millisecond of the local day; `dueNotAfter` is the start of the local day of `ends_at` minus 1 ms | `due <= endOfLocalDay` in scheduler.md; the day before `ends_at`, not `ends_at` minus 24 hours (a day is 23 or 25 hours across DST) |
| 17 | Known limit: a zone whose DST gap covers local midnight (America/Sao_Paulo before 2019) gets a day start 1 hour early | no such zone is used; a `shortcut:` comment marks it |

## Amendment (Task 6a, [decision 0026](0026-task6-scheduler-choices.md))

The clamp condition in choice 16's neighbourhood changed: the service clamps only when `dueNotAfter > endOfLocalDay(now)`, not `dueNotAfter > now`. The first rule clamped a card answered on the `dueNotAfter` day to the end of that same day, so `next()` selected it again at once and kept doing so (a simulation reached streak 902). S51 now reads "answered on or after the day of `dueNotAfter`". The text above is left as it was written. Choice 12's open item (reviews of a re-created enrollment) is answered in 0026: they are deleted with the enrollment.

## Rejection reasons and the texts they map to

Texts are the ones in [scheduler.md](../scheduler.md) and [integration.md](../slack/integration.md). One code per text.

| code | when | text |
| --- | --- | --- |
| `sent_again` | the click's message is not the stored `message_ts` | "This card was sent again, use the latest message" |
| `removed` | the enrollment has `removed_at` | "You are no longer enrolled in this course" |
| `course_over` | the enrollment is not `active` (completed, exempt) or the course is not `active` | "the course is over" |
| `not_open` | no `card_states` row or `sent_at` is null (also an unknown card) | no text in the docs; `src/slack/card.ts` has "This card was already answered." from the spike |
| `not_enrolled` | no enrollment of this user in the card's course (also covers another student's card) | no text in the docs |

Doc texts with no code: "expired" and "Sent again below" replace a Slack message when a student is removed or a reminder is posted; they are not answers to a click and belong to Tasks 6 and 7. Codes with no text: `not_open` and `not_enrolled`; Task 8 picks their wording.

## Consequences

- Test ids covered: S2, S3, S4, S10, S13, S14, S31, S33, S34, S37, S41, S49 to S52, plus the extra cases listed in [test-plan.md](../test-plan.md#answer-service-task-5).
- Verified on real Postgres: two clicks at the same time give one `answered` and one `duplicate` (or `not_open`); in a run of 5 races 4 hit the unique key (`duplicate`) and 1 arrived after the commit (`not_open`).
- Open for Tasks 6 and 7: `listAssessmentReviews` reads the first review per assessment card across the user's history in the course. If a re-created enrollment (after the 14-day cleanup, which also deletes the reviews) ever kept old reviews, the evaluation would see them; the cleanup deletes them, so this is only a risk if that changes.
- Not tested: rollback of the whole transaction when a later write fails (by construction, every write uses the transaction handle).
