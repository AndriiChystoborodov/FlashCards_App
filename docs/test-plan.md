# Test plan

Vitest. Tests sit next to the code for the domain; service and route tests under `tests/` or next to the service. AGENTS.md: write the tests after the implementation, one for each way the code resolves. Table ids (C1, S1, ...) are for traceability in commit messages.

## Test levels

| level | scope | needs |
| --- | --- | --- |
| Unit | `src/domain/` pure functions | nothing; `enable_fuzz: false`, `now` passed in |
| Service | scheduler, answer, enrollment services | test database, fake Slack interface |
| Route | REST with supertest | test database, fake services where useful |
| Slack handler | Bolt handlers with fake `ack`, `respond` | fake service |
| MCP | tools against a fake REST server | SDK in-memory client and server |
| Manual spike | real Slack workspace | Roadmap Task 2 only |

## Calculator

| id | case | expected |
| --- | --- | --- |
| C1 | new card, right + medium | grade Good, streak 1, not learned, `due` from ts-fsrs |
| C2 | right + easy | grade Easy, streak 1 |
| C3 | right + hard | grade Hard, streak 0 |
| C4 | wrong option | Again, streak 0, review rating null, `isCorrect` false |
| C5 | `chosenOption: null` | Again, streak 0 |
| C6 | medium, medium | streak 2, `learnedAt = now` of second answer |
| C7 | medium, hard, medium | streak 1, not learned |
| C8 | easy, wrong, medium | streak 1 (wrong reset) |
| C9 | already learned, then wrong | streak 0, `learnedAt` kept |
| C10 | right with no rating | throws `MissingRatingError` |
| C11 | wrong with a rating | rating ignored, review rating null |
| C12 | input state is not mutated | deep-equal before and after |
| C13 | `now` is the only clock | same input, same output on repeat |
| C14 | FSRS delegation | `due` equals `scheduler.next(...).card.due`; no hand-made math |
| C15 | numbers from [walkthrough.md](walkthrough.md) | Good, Good gives scheduled_days 2 then 11 (stability 2.31, 10.96); Easy, Easy gives 8, 66; Again on a fresh card gives 1 (stability 0.21); Good, Again gives 2, 1 |
| C16 | `newCardState` | state 0, streak 0, `learnedAt` null, `last_review` undefined |
| C17 | custom scheduler argument is used | stub scheduler called once |

## Assessment evaluation

| id | case | expected |
| --- | --- | --- |
| A1 | all right + easy, threshold 90 | score 100, exempt |
| A2 | 9 of 10 right + easy, threshold 90 | score 90, exempt (inclusive `>=`) |
| A3 | 8 of 10 | not exempt |
| A4 | all right + medium | score 0, not exempt |
| A5 | right + hard | not passed |
| A6 | wrong or null | not passed |
| A7 | threshold 100 with one failure | not exempt |
| A8 | zero assessment cards | `score` null, not exempt; service sets `assessment_done_at` at once |
| A9 | `passedFlags` order matches input | yes |

## Scheduler and services

| id | case | expected |
| --- | --- | --- |
| S1 | enrollment with open assessment | assessment cards come first, ignoring the new-card quota |
| S2 | last assessment answered | `assessment_done_at` set once; evaluation runs once |
| S3 | exempt student | no cards, progress 100 |
| S4 | not exempt | passed assessment cards learned, others in FSRS |
| S5 | due card and new card | due first |
| S6 | quota reached for today (`introducedToday` equals `quotaToday`) | no more new cards |
| S24 | quota formula: (7 remaining, 12 days left), (7, 1), (0, 5) | 1, 7, 0 |
| S25 | quota stays constant during a day while cards are introduced | `introducedToday + remaining` unchanged, same quota |
| S26 | student skips two days | next quota rises accordingly, course still ends on time |
| S27 | card added mid-course | quota rises; `ends_at` already passed gives remainingDays 1 |
| S7 | day boundary in the student's timezone | counter resets at local midnight |
| S8 | learned card | never selected |
| S9 | one card open | nothing else sent |
| S10 | answer closes card | `sent_at` cleared, next card sent |
| S11 | double claim by two ticks | one wins |
| S12 | crash after claim, before Slack | re-sent after 10 minutes, no second state row |
| S13 | duplicate answer (same delivery) | second ignored, one review row |
| S14 | answer for a card not open | rejected |
| S15 | course not active or enrollment not active | no sends |
| S16 | all cards learned | enrollment `completed` once, `completed_at` and `completed_progress` (100) stored |
| S28 | `ends_at` reached with 6 of 10 cards learned | `completed`, `completed_progress` 60, no cards sent afterwards, course `finished` |
| S29 | completed student, cards added to the course | stays `completed`, progress still 60 |
| S30 | exempt student at `ends_at` | stays `exempt`, progress 100 |
| S31 | click on an open card after completion | "the course is over", no review stored |
| S17 | card added mid-course | introduced by position |
| S18 | unanswered 24 hours | card re-posted once, old message replaced, `reminder_count` 1, `sent_at` unchanged, no new card |
| S32 | unanswered after `MAX_REMINDERS` reminders | nothing more is sent; the card stays open |
| S33 | click on the old message after a reminder | "sent again", no state change |
| S34 | answer after a reminder | one review for the delivery, next card follows |
| S35 | reminder before local `SEND_HOUR` | not sent |
| S19 | send hour before local `SEND_HOUR` | not sent |
| S21 | card answered at 14:00 with `scheduled_days` 3; tick at 09:00 on day 3 | card is selected (`due` before end of local day), not delayed to day 4 |
| S22 | course with zero assessment cards, new enrollment | `assessment_done_at` set in the same `next()` call; a new card is returned, no loop |
| S23 | `due` just after local midnight in another timezone | selected on the right local day |
| S20 | progress and class progress | learned / total, averages, exempt = 100 |

## REST routes

| id | case | expected |
| --- | --- | --- |
| R1 | no or bad token | 401 |
| R2 | another teacher's course | 404 |
| R3 | create course defaults | `draft`, threshold 90; missing `ends_at` gives 400 |
| R4 | create flashcards with bad `correct_option` | 400 |
| R5 | start with zero cards | 409 |
| R6 | start, stop transitions | draft to active to finished only |
| R7 | delete a sent flashcard | 409 |
| R8 | enroll with and without Slack match | `slack_matched` true and false |
| R9 | review without rating on a right answer | 400 |
| R10 | review with rating on a wrong answer | 200, rating null |
| R11 | `correct_option` appears in the response only after answer | yes |

## Slack handlers

| id | case | expected |
| --- | --- | --- |
| H1 | `ack()` is called before any await on services | yes |
| H2 | button values never contain the correct answer | assert on built blocks |
| H3 | value fails zod | ignored and logged |
| H4 | click by a user who does not own the card | rejected |
| H5 | right answer first click | rating buttons shown, no state change |
| H6 | rating click | calculator called, message replaced with no buttons |
| H7 | wrong or Don't know | right answer and material shown |
| H8 | action id regex | `answer_1..3`, `answer_dont_know`, `rate_*` all routed |
| H9 | card with 9 options | text and labels within limits |

## MCP

| id | case | expected |
| --- | --- | --- |
| M1 | each tool calls the mapped route with the token | one test per tool in the table |
| M2 | API 4xx | tool result has `isError` |
| M3 | invalid input | rejected by zod before the HTTP call |
| M4 | start and stop descriptions mention notifications | yes |

## Non-functional checks

- Load script: 1,000 students, scheduler tick with a fake Slack that sleeps; assert sequential sending and no rejected promise.
- Typecheck with `strict`; lint rule or grep forbidding `any`.
- Env validation: missing variable stops startup with a clear message.

## Exit criteria per Roadmap task

Each task ends with passing tests where it makes sense and a commit. Task 3 is done when C1 to C17 and A1 to A9 pass.
