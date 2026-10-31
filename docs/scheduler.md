# Flashcard scheduler

Decides which card each student gets, when, and sends it. It lives in a service (`src/services/`), uses the pure rules in `src/domain/`, and sends through the Slack module. One process, no Redis.

## Clock

The scheduler, the answer service and the tick never call `new Date()`. They take time from an injectable clock (`interface Clock { now(): Date }`), so the end-to-end scenario script can advance days ([decision 0023](decisions/0023-local-first.md), Task 4a). The domain functions already receive `now` as a parameter.

## Delivery model ([decision 0008](decisions/0008-delivery-next-card-after-answer.md))

One open card per student per course. The next card is sent right after the previous one is answered, until the day's work is done. A daily tick starts the day by sending the first card.

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Open: tick sends a card (sent_at set)
  Open --> Open: answered, another card is due, send next
  Open --> Idle: answered, nothing more today
```

A card left unanswered stays open and blocks the queue. It is not forgotten: see [Unanswered cards](#unanswered-cards). The student's streak and due date are untouched until they answer.

## Selecting the next card

```
next(enrollment, now):
  if course.status != 'active' or enrollment.status != 'active': none
  if enrollment.removed_at is not null: none                   // decision 0017
  if a card_states row has sent_at not null: none            // one open card
  if assessment_done_at is null:
      assessment cards without a row, by position            // assessment first
      (none left and all answered -> evaluateAssessment once)
  due   = card_states, learned_at null, due <= endOfLocalDay(now, tz), order by due
  new   = flashcards without a row, not assessment, by position,
          while introduced_today < quotaToday           // decision 0006
  return first of (due, then new)
```

- `endOfLocalDay` is the end of the student's local day (from `users.tz`, fallback `TENANT_TIMEZONE`). Comparing `due` with `now` would be wrong: the tick runs once a day at `SEND_HOUR`, so a card answered at 14:00 and due in 3 days has `due` of 14:00 on day 3, which is after the 09:00 tick, and would wait until day 4. Anything due today is sent at the morning tick.
- Learned (`learned_at` set) follows [decision 0015](decisions/0015-learned-needs-retention-gap.md): streak of 2 plus at least 7 days since the previous review. A card with a streak of 2 and a short gap is still due and is asked again.
- After `applyAnswer`, the answer service clamps the new `due` to `dueNotAfter`: the end of the local day (student timezone) before `courses.ends_at`. FSRS dues after that are clamped to it when that day is later than today's local day, so every unlearned card gets a last review before the course ends and a card answered on that last day is not sent again. See [fsrs-calculator.md](fsrs-calculator.md#clamping-due-in-the-answer-service).
- Not decided: what to do with cards introduced late; see the open question below. Until it is decided, late cards may stay unlearned and progress shows that honestly.
- A card gets its `card_states` row when first sent (`newCardState(now)`), with `introduced_at = now` and `sent_at = now`.
- `introduced_today` counts `introduced_at` inside the student's local day, for non-assessment cards only (`flashcards.is_assessment = false`). Assessment cards also get `introduced_at` on their first send, but they are not counted: they ignore the quota and must not use it up.
- Zero assessment cards in the course: `next()` sets `assessment_done_at = now`, leaves `assessment_score` null, and continues in normal mode in the same call. This is the same completion step as after the last assessment answer, minus the evaluation.
- `quotaToday = ceil((remainingNew + introducedToday) / remainingDays)` ([decision 0006](decisions/0006-new-cards-per-day.md)), recalculated each day from the number of unintroduced non-assessment cards and the local days left through `ends_at`. Assessment cards are not counted.
- Assessment cards ignore the quota; the student gets them all, one after another, before anything else.
- Due cards have no daily cap in the MVP. If a student falls behind, the backlog drains one card per answer. Open: add `MAX_DUE_PER_DAY` if students complain.
- Catch-up ([decision 0035](decisions/0035-course-titles-and-catch-up-dm.md)): the first tick after a pause finishes every active course whose `ends_at` has passed. Enrollments are completed and open cards replaced with text only, but the "course ended" DM is sent only if `ends_at` is at most 24 hours old. A stop never skips the DM. Each finished course logs `course <id> finished: completed=N replaced=M failed=K`.
- Completion ([decision 0011](decisions/0011-enrollment-completed.md)): an `active` enrollment becomes `completed` when all its cards are learned or when the course reaches `ends_at`, whichever comes first. `afterAnswer` (after the last learned card) and `finishEndedCourses` (at `ends_at`, called by the tick) set `status`, `completed_at` and `completed_progress`, and send a DM that names the course (congratulation, or "the course has ended" with the final progress). A completed enrollment gets no cards and no reminders.
- At `ends_at` the tick completes every remaining `active` enrollment and sets the course to `finished`: `finishEndedCourses(deps)`, built in 6a; the tick that calls it is 6b-1. Until the tick runs, `next()` already returns none once `now >= ends_at`.
- Exempt students get no cards and never become `completed`.

> **Open question: short courses cannot finish.** The daily N spreads new cards over the whole course ([decision 0006](decisions/0006-new-cards-per-day.md)), and a card is learned only after a 7-day retention gap ([decision 0015](decisions/0015-learned-needs-retention-gap.md)). Together, a card introduced late has no time left to reach the gap before `ends_at`. In the walkthrough's 12-day course a student who answers every card Medium can learn only about 5 of 10 cards (the user's estimate; recomputed in Task 6a: 4 of 10, see [decision 0026](decisions/0026-task6-scheduler-choices.md)). Options:
>
> 1. Stop introducing new cards `INTRO_CUTOFF_DAYS` (10) before `ends_at`.
> 2. Scale `MIN_RETENTION_DAYS` with the course length.
> 3. Require courses of about 4 weeks or more (reject or warn at `start`).
>
> Decided for now ([decision 0026](decisions/0026-task6-scheduler-choices.md)): none of the three. The quota runs to `ends_at` and the limit is recorded; the walkthrough's perfect Medium student learns 4 of 10.

## When a card is sent

- Course start and enrolling a student into an active course send the first assessment card at once (not gated by `SEND_HOUR`).
- After an answer, the answer handler calls `next()` immediately and sends the next card if there is one. Same selection rule, same daily new-card cap, no `SEND_HOUR` gate.
- The daily tick restarts students who have no open card and whose local hour is at least `SEND_HOUR`.

## Unanswered cards

A card counts as open while `card_states.sent_at` is set. Without a rule an ignored card would stay open forever and the student would never see another one.

The tick, for each open card with a stored `message_ts`, in a `active` enrollment of an `active` course, and when the student's local hour is at least `SEND_HOUR`:

1. Reminder due when `coalesce(reminded_at, sent_at) + REMINDER_AFTER_HOURS <= now` and `reminder_count < MAX_REMINDERS`.
2. Re-post the same card as a new message ("Reminder: you have an open card" plus the question and buttons) and replace the old message with "Sent again below" and no buttons.
3. Store the new `message_channel` and `message_ts`, set `reminded_at = now`, `reminder_count = reminder_count + 1`. `sent_at` does not change: it is still the same delivery, so an answer to either message closes it once.
4. After `MAX_REMINDERS` reminders nothing more is sent. The card stays open and the student can still answer the last message; the next card follows the answer.
5. **The open card blocks that student's course** (one open card at a time, [decision 0008](decisions/0008-delivery-next-card-after-answer.md)), however long it stays unanswered. The teacher sees it: the progress endpoints return `waiting_since`, the open card's `sent_at`, or null when no card is open ([rest-api.md](rest-api.md#progress-teacher)). The blockage ends when the student answers, the enrollment is removed, or the course ends. The system does not skip the card by itself.

A click on an older message than the stored `message_ts` is answered with "This card was sent again, use the latest message" and does not change state. Nothing is lost by ignoring a card: the streak and `due` stay as they were until the answer.

At `ends_at` or on stop, open cards are closed with the enrollment ([completion](#selecting-the-next-card)); a late click gets "the course is over".

## Removed students and cleanup

[Decision 0017](decisions/0017-enrollment-soft-delete.md). Every selection, reminder and completion query filters `enrollments.removed_at is null`.

- On removal the service voids the open card: replaces the Slack message with "expired", then clears `sent_at`, `message_ts`, `reminded_at`, `reminder_count`. Progress and `status` are untouched.
- A click on an expired card gets "You are no longer enrolled in this course" and changes nothing.
- Re-enrolling inside the window clears `removed_at`; the next `next()` call picks up overdue cards and re-sends the voided card.
- `ends_at` completion ignores removed enrollments.
- **Daily cleanup**, run by the tick once per day: for each enrollment with `removed_at < now - REMOVED_RETENTION_DAYS` delete, in one transaction, the student's `reviews` and `card_states` for the flashcards of that course, then the enrollment row. The `users` row stays.

## Tick

Built in Task 6b-1 ([decision 0027](decisions/0027-task6b1-tick-choices.md)): `runTick(deps, cfg)` and `startTick(deps, cfg)` in `src/services/tick.ts`. `startTick` runs `runTick` every `TICK_MINUTES` (default 15) with `setInterval`; the first pass is one interval after the start. A pass that is still running when the next interval fires makes that interval skip, so passes never overlap. `src/index.ts` starts it (Task 8) with the real Slack adapter and logs one line per pass (`sent`, `resent`, `failed`); the end-to-end scenario calls `runTick` with the controllable clock and the `FakeSlack`.

Once per day (the first tick after local midnight of `TENANT_TIMEZONE`, tracked in memory and safe to repeat) the tick will also run the removed-students cleanup described above: hard-delete after `REMOVED_RETENTION_DAYS`. Not built yet (Task 6b-2), like the reminders.

One `runTick` pass, with the time read once from the clock:

1. `finishEndedCourses`: every `active` course whose `ends_at` has passed is finished and its `active` enrollments completed.
2. For each present (`removed_at is null`) `active` enrollment of an `active` course, one student after another; an error is logged and counted and the pass goes on:
   - **Open card** (`sent_at` set): if it has no `message_ts` and `sent_at` is at least 10 minutes old (the claim was made and the post never recorded), post the same card again and record the message; `sent_at` does not change. This is not gated by `SEND_HOUR`: the send was already started. Any other open card is left alone.
   - **No open card:** compute the student's local hour from `users.tz` (fallback `TENANT_TIMEZONE`, invalid values warn and fall back) using `Intl.DateTimeFormat`. If it is at least `SEND_HOUR` (default 9), run `sendNext`. There is no "already sent today" check: no column records it (`sent_at` is cleared on answer), and none is needed, because `next()` returns none once the day's due cards are done and the quota is used up, so repeating it every 15 minutes sends nothing new.

A student without a Slack id is skipped by `sendNext` before any card is claimed. If every student shares a timezone, one daily tick is enough; the per-student version costs only the tz lookup. With a 15-minute tick a stale claim is re-posted 10 to 25 minutes after it was made.

## Idempotent send

```mermaid
sequenceDiagram
  participant T as Tick or answer handler
  participant DB
  participant S as Slack
  T->>DB: claim: upsert card_states, set sent_at where sent_at is null
  alt claim failed
    T-->>T: skip (already open)
  else claimed
    T->>S: chat.postMessage
    S-->>T: channel, ts
    T->>DB: save message_channel, message_ts
  end
```

- Crash after the claim and before Slack: a row has `sent_at` older than 10 minutes and no `message_ts`. The tick re-posts it (Task 6b-1, `resendStaleClaim`). A rare duplicate DM is acceptable because answers are idempotent (`reviews` unique on `delivery_sent_at`).
- The claim is one `INSERT ... ON CONFLICT DO UPDATE SET sent_at = now, message_channel = null, message_ts = null WHERE sent_at IS NULL` (`claimCard`; the message fields of the previous delivery are cleared), and the whole selection plus claim runs under `SELECT ... FOR UPDATE` on the enrollment row, so two ticks, or a tick and an answer, cannot leave two open cards (decision 0026). The lock covers the selection and the claim, also across instances; `SKIP LOCKED` is not used. The stale-claim re-post is not under the lock: it records its message only while the same delivery (`sent_at`) is still open, and two instances could both re-post one card (accepted). The re-post is skipped for a course that has ended.

## Answer path

1. Handler `ack()`s, parses the button value, loads the card state and checks `sent_at` is set.
2. Wrong or "Don't know": `applyAnswer` now. Right: show Hard / Medium / Easy, no state change.
3. Rating click: `applyAnswer`, clamp `due` to the course end, insert the review (unique key rejects repeats), update `card_states`, clear `sent_at`, replace the Slack message with the outcome.
4. If it was the last assessment card, `evaluateAssessment`; the service sets `learnedAt = now` on the passed ones (the function returns flags only).
5. Call `next()` and send the next card if any.

Steps 3 to 4 run in one transaction.

Built in Task 5 as `submitAnswer` in `src/services/answer.ts` ([decision 0025](decisions/0025-task5-answer-service-choices.md)): it covers steps 3 and 4 (the Slack first click and steps 1, 2 and 5 are Task 8 and Task 6). It checks the card in this order and refuses with a reason code, storing nothing: `removed`, `course_over`, `not_open`, `sent_again` (plus `not_enrolled`). A repeated delivery returns `duplicate`. An answer clears `sent_at`, `reminded_at` and `reminder_count`. It does not complete an enrollment: `afterAnswer` in `src/services/scheduler.ts` does (S16).

## Built in Task 6a

[Decision 0026](decisions/0026-task6-scheduler-choices.md). `src/services/scheduler.ts`: `next` (selection, no claim), `sendNext` (guards, selection and claim in one transaction under a `FOR UPDATE` lock on the enrollment row, then the Slack post and `message_channel`/`message_ts`), `sendFirstCards` (course start), `afterAnswer` (exempt message, completion, next card), `completeIfLearned`, `finishCourse` and `finishEndedCourses`. Slack is the `SlackPort` interface (`src/slack/port.ts`) with the recording `FakeSlack`; the Bolt implementation is Task 8. The daily tick and stale-claim recovery are Task 6b-1 (below, in Tick); reminders and cleanup (6b-2) are not built (Task 6b-2). A Slack failure after the claim leaves the card open without a `message_ts` until the tick re-posts it. The tick: [decision 0027](decisions/0027-task6b1-tick-choices.md).

## Load

1,000 students at a few to a dozen cards per day is a few thousand DMs. Send sequentially; the Slack client retries on HTTP 429 using `Retry-After`. `chat.postMessage` is roughly 1 message per second per channel with bursts allowed, and each student's DM is its own channel. No rate limiter is built for the MVP. Do not use `Promise.all` over the whole class.

## Config

| name | default | where |
| --- | --- | --- |
| `SEND_HOUR` | 9 | env |
| `TENANT_TIMEZONE` | `UTC` | env |
| `TICK_MINUTES` | 15 | env |
| `REMINDER_AFTER_HOURS` | 24 | env |
| `MAX_REMINDERS` | 2 | env |
| `REMOVED_RETENTION_DAYS` | 14 | env |
