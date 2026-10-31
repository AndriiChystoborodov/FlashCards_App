# Test plan

Vitest. Tests sit next to the code (`src/**/*.test.ts`, as `vitest.config.ts` discovers them), including service, route and repository tests (repository tests in `src/db/`). AGENTS.md: write the tests after the implementation, one for each way the code resolves. Table ids (C1, S1, ...) are for traceability in commit messages.

## Test levels

| level | scope | needs |
| --- | --- | --- |
| Unit | `src/domain/` pure functions | nothing; `enable_fuzz: false`, `now` passed in |
| Service | scheduler, answer, enrollment services | test database, fake Slack interface |
| Route | REST over real HTTP on `127.0.0.1:0` with Node's `fetch` (`src/api/testClient.ts`; no supertest, one dependency fewer, [decision 0028](decisions/0028-task7-rest-api-choices.md)) | test database, fake Slack |
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
| C6 | medium, medium, second answer 8 days after the first | streak 2, `learnedAt = now` of second answer |
| C18 | medium, medium, second answer 2 days after the first | streak 2, not learned |
| C19 | gap exactly 7 days (7 x 24 h), streak 2, right + medium | learned |
| C20 | gap just under 7 days (6 d 23 h 59 min) | not learned |
| C21 | streak 2 with a short gap, then a third right Medium answer with gap of 7 or more days | streak 3, learned at the third |
| C22 | streak 2, gap 7 or more days, but rating hard | streak 0, not learned |
| C23 | state with no `last_review` (first answer) | gap condition fails, not learned |
| C7 | medium, hard, medium (any gaps) | streak 1, not learned |
| C8 | easy, wrong, medium | streak 1 (wrong reset) |
| C9 | already learned, then wrong (`learnedAt` was set by an earlier answer) | streak 0, `learnedAt` kept |
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

## Database (Task 4)

Run on the local Postgres from `docker-compose.yml` ([decision 0022](decisions/0022-task4-schema-choices.md)); mapper cases also run without it.

| id | case | expected |
| --- | --- | --- |
| D1 | `CardState` with `last_review` undefined | stored as NULL, read back undefined |
| D2 | `last_review` and fractional stability | read back equal |
| D3 | `learnedAt` null and set | read back equal |
| D4 | ts-fsrs state 0, 1, 2, 3 | read back equal |
| D5 | `newCardState` | round-trips (covered by D1) |
| D6 | learned card, streak 0 (C9 shape) | `learnedAt` kept |
| D7 | duplicate `card_states (user_id, flashcard_id)` or `enrollments (course_id, user_id)` | rejected |
| D8 | second review for the same delivery | `insertReview` returns false, one row |
| D9 | removed enrollment | not returned by the present predicate |
| D10 | defaults | threshold 90, streak 0, reminder count 0 |
| D11 | course without `ends_at` | rejected |
| D12 | migration on an empty database | six tables, row level security on |

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
| S53 | assessment cards sent today (`introduced_at` set), 7 non-assessment cards remain, 12 days left | `introducedToday` is 0, quota 1, one new card may be introduced |
| S25 | quota stays constant during a day while cards are introduced | `introducedToday + remaining` unchanged, same quota |
| S26 | student skips two days | next quota rises accordingly, course still ends on time |
| S27 | card added mid-course | quota rises; `ends_at` already passed gives remainingDays 1 |
| S7 | day boundary in the student's timezone | counter resets at local midnight |
| S8 | learned card | never selected |
| S36 | streak 2 with a short gap | card still due and selected again |
| S37 | answer service computes `dueNotAfter` | end of the local day before `ends_at` in the student's timezone, including a timezone whose day differs from UTC |
| S49 | new `due` after `dueNotAfter` and `dueNotAfter` after the end of today's local day | service clamps `due = dueNotAfter`; other fields unchanged |
| S50 | new `due` before `dueNotAfter` | `due` unchanged |
| S51 | `dueNotAfter <= endOfLocalDay(now)` (answer on the last review day or later) | not clamped; the card is not selected again the same day (amended in Task 6, [decision 0026](decisions/0026-task6-scheduler-choices.md)) |
| S52 | clamped card answered right + medium 5 days later, streak 2 | not learned (gap < 7) |
| S38 | card introduced 5 days before `ends_at` | cannot become learned; progress shows it unlearned at `ends_at` |
| S39 | removed student, tick | no card, no reminder, not completed at `ends_at` |
| S40 | removal with an open card | Slack message replaced with "expired", `sent_at` and `message_ts` cleared, progress unchanged |
| S41 | click on the expired message | "no longer enrolled", no review stored |
| S42 | restore with overdue cards and a voided card | overdue cards are selected, the voided card is sent again |
| S43 | cleanup at 13 days 23 h | nothing deleted |
| S44 | cleanup after 14 days | reviews, card_states, enrollment of that course deleted in one transaction; `users` row and other courses' data kept |
| S45 | class progress with a removed student | excluded from the average |
| S46 | `next()` for an enrollment with `removed_at` set | none returned, even with due cards |
| S47 | the tick on the first run after local midnight | cleanup runs once; a second tick the same day does not run it again |
| S48 | open card unanswered past `MAX_REMINDERS` | no new card, no more reminders, `waiting_since` equals the card's `sent_at` |
| S9 | one card open | nothing else sent |
| S10 | answer closes card | `sent_at` cleared, next card sent |
| S11 | double claim by two ticks | one wins |
| S12 | crash after claim, before Slack | re-sent after 10 minutes, no second state row |
| S13 | duplicate answer (same delivery) | second ignored, one review row |
| S14 | answer for a card not open | rejected |
| S15 | course not active or enrollment not active | no sends |
| S16 | all cards learned | enrollment `completed` once, `completed_at` and `completed_progress` (100) stored |
| S28 | `ends_at` reached with 6 of 10 cards learned | `completed`, `completed_progress` 60, no cards sent afterwards, course `finished` |
| S28a | catch-up finish 24 hours and 1 minute after `ends_at` ([decision 0035](decisions/0035-course-titles-and-catch-up-dm.md)) | enrollment `completed`, course `finished`, the open card replaced with text only, no "course ended" DM |
| S28b | catch-up finish exactly 24 hours after `ends_at` | the DM is sent: `The course "C" has ended. Your final progress is 0%.` |
| S28c | `finishCourse` without catch-up (a stop) long after `ends_at` | the DM is always sent |
| S28d | a finished course | one log line `course <id> finished: completed=N replaced=M failed=K`; a failed DM counts as failed; a second finish logs nothing |
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

### Tick (Task 6b-1)

`src/services/tick.test.ts` (test database, `FakeSlack`; passes are limited to the test's own course with `courseIds` so they do not touch other tests' courses) and `localHour` cases in `src/domain/localDay.test.ts`:

| case | expected |
| --- | --- |
| S19 | 08:59 Zurich sends nothing, 09:00 sends; Auckland and a null `tz` (tenant timezone) use their own hour; a repeated tick sends nothing new |
| DST days | 2026-03-29 (23 h) and 2026-10-25 (25 h): `SEND_HOUR` is local, a card due at 23:30 local is due today, one due at 00:30 tomorrow is not |
| no Slack id, removed, exempt, completed, draft course | nothing sent, no card claimed (S39 tick part) |
| failure isolation | one student's post fails, the other still gets the card, the summary counts both |
| S12 | claim younger than 10 minutes left alone; at 10 minutes re-posted once, same `sent_at`, one `card_states` row; not gated by `SEND_HOUR`; a card with a recorded message is never re-posted |
| `ends_at` | the tick finishes the course and completes the enrollment once |
| re-post racing an answer | the answer closes the delivery while the re-post's Slack call is in flight (a gated fake): the closed card keeps `message_ts` and `message_channel` null |
| re-post for an ended course | a stale claim in a course past `ends_at` that is still `active`: `resendStaleClaim` returns false and posts nothing; `runTick` finishes the course and the only message is the course-ended DM |
| `startTick`, real 20 ms interval | overlapping intervals are skipped while a pass waits for Slack (counts only), the next pass runs after it, `stop()` ends the runs |
| `localHour` | Zurich both DST days, Asia/Kolkata (+5:30), America/New_York 2026-03-08 and 2026-11-01, midnight is 0 |

### Scheduler core (Task 6a)

`src/services/scheduler.test.ts` (test database, `FakeSlack`), `src/domain/quota.test.ts` (S24 to S27) and the new cases in `src/domain/localDay.test.ts`. Besides the S ids above:

| case | expected |
| --- | --- |
| clamp regression | a card answered on the `dueNotAfter` day is asked once, then `next()` returns none (the old rule asked it 900 times in a simulation); S51 for both days |
| concurrent `sendNext` (8 callers, 30 rounds, two shapes) | exactly one `sent`, one post, one open card; checked on real Postgres. Without `FOR UPDATE` the same test fails ([decision 0026](decisions/0026-task6-scheduler-choices.md)) |
| first cards | `sendFirstCards` posts to every present `active` student with a Slack id, not to `exempt`, removed or unmatched ones; repeating sends nothing |
| Slack failure after the claim | the error reaches the caller; the card stays open with no `message_ts` (6b-2 re-sends it) |
| DM channel | cached in `users.slack_dm_channel` after the first post and used afterwards |
| no real clock | the source of `scheduler.ts` has no `new Date()` or `Date.now` |
| `localDaysThrough`, `startOfLocalDayOf` | walkthrough Monday to Friday is 12; local day not UTC day; DST day; at least 1 |

### Answer service (Task 5)

`src/services/answer.test.ts` and `src/domain/localDay.test.ts`, on the test database. Besides the S ids in the table above:

| case | expected |
| --- | --- |
| walkthrough section 2: Easy, Medium, "Don't know" | score 33.33, not exempt, `assessment_done_at` set once, only the Easy card `learned_at`; a later click is `not_open` and `assessment_done_at` does not move |
| Hard or Medium on assessment cards | not a pass, score 0 |
| a normal card answered while the assessment is open | no evaluation |
| score equal to the threshold | exempt |
| two clicks at the same time (`Promise.all`) | one `answered`, the other `duplicate` or `not_open`, one review row |
| `chosenOption` outside the options, or a right answer without a rating | `InvalidOptionError` or `MissingRatingError`, no review, `sent_at` kept |
| rejection reasons | `not_open`, `not_enrolled`, `removed`, `course_over` (completed enrollment, finished course), `sent_again`; nothing stored |
| clamp | S49 to S52, S37 for Auckland, Los Angeles and the Zurich spring-forward day; stored state equals `applyAnswer` except `due` |
| invalid `users.tz` | falls back to `TENANT_TIMEZONE`, one `console.warn` with the user id and the value; a null `tz` does not warn |
| no real clock | the source of `answer.ts` has no `new Date()` or `Date.now` |
| `endOfLocalDay`, `dueNotAfter` | Zurich 2026-03-29 (23 h) and 2026-10-25 (25 h), a moment after local midnight, Auckland, Los Angeles, Kolkata, year end |

## REST routes

| id | case | expected |
| --- | --- | --- |
| R1 | no or bad token | 401 |
| R2 | another teacher's course | 404 |
| R3 | create course defaults | `draft`, threshold 90; missing `ends_at` gives 400 |
| R4 | create flashcards with bad `correct_option` | 400 |
| R5 | start with zero cards | 409 |
| R6 | start, stop transitions | draft to active to finished only |
| R7 | delete or patch (incl. `is_assessment`) a flashcard in an `active` course | 409 `course_not_draft`, card unchanged |
| R12 | delete and patch in a `draft` course | allowed |
| R13 | add cards to an `active` course | 201; position at the end; `is_assessment: true` gives 400 `assessment_closed` |
| R14 | add, patch or delete in a `finished` course | 409: add is `course_finished`, patch and delete are `course_not_draft` ([decision 0016](decisions/0016-flashcards-frozen-after-start.md)) |
| R15 | `DELETE .../students/:studentId` | `removed_at` set, 204; the student disappears from list, progress and `student_count` |
| R16 | the same call again | 204, `removed_at` unchanged |
| R17 | re-enroll within 14 days | `removed_at` cleared, progress and `card_states` intact, `restored: true` |
| R18 | re-enroll after the cleanup | new enrollment, assessment first, no old reviews. **Simulated until 6b-2**: the daily cleanup job is not built, so the test advances the clock 15 days and the enroll route runs the same `hardDeleteEnrollment` the job will reuse; the job itself (S43, S44, S47) is 6b-2 |
| R19 | student routes with `STUDENT_ROUTES_ENABLED` unset or false | 404, for every bind host. With the flag on they exist only for a loopback bind host: `src/api/server.test.ts` runs a table of host forms (`127.0.0.1`, `::1`, `[::1]`, `localhost` in any case, `localhost.` are loopback; `0.0.0.0`, `''`, `::`, `::ffff:127.0.0.1`, `localhost.evil.com`, `127.0.0.2`, ... are not) and checks that a non-loopback host fails at startup |
| R20 | env validation: `STUDENT_ROUTES_ENABLED=true` with `NODE_ENV=production` | startup fails with a clear message |
| R21 | PATCH `is_assessment` on an `active` course | 409 `course_not_draft` |
| R22 | progress endpoints with an open card and with none | `waiting_since` is the card's `sent_at`, or null |
| R23 | card sent, then `MAX_REMINDERS` reminders pass with no answer; `GET /courses/:courseId/students/:studentId/progress` and the class `GET /courses/:courseId/progress` | the student's `waiting_since` equals the open card's original `sent_at` (reminders do not change it); no new card was sent **Simulated until 6b-2**: reminders are not built, so the test advances the clock 10 days and sets `reminder_count` 3 and `reminded_at` directly; the real reminder path (S18, S32, S48) is 6b-2 |
| R24 | the student then answers the card | `waiting_since` is null in both endpoints |
| R25 | open card, then the student is removed | the student is gone from the lists; after a restore into an `active` course the voided card is sent again at once (like a new enrollment, [decision 0028](decisions/0028-task7-rest-api-choices.md)), so `waiting_since` is that new `sent_at`, not the old one (null only for a student without a Slack id) |
| R26 | PATCH `assessment_pass_threshold` on an `active` course | 409 `threshold_locked`, value unchanged |
| R27 | PATCH `ends_at` to an earlier value on an `active` course | 409 `ends_at_shortened`, value unchanged |
| R28 | PATCH `ends_at` to a later value on an `active` course; PATCH `ends_at` and `assessment_pass_threshold` on a `draft` course | 200, values saved |
| R29 | PATCH any field on a `finished` course | 409 `course_finished` |
| R8 | enroll with and without Slack match | `slack_matched` true and false |
| R9 | review without rating on a right answer | 400 |
| R10 | review with rating on a wrong answer | 200, rating null |
| R11 | `correct_option` appears in the response only after answer | yes |

### REST routes (Task 7)

Run over HTTP on the test database with a controlled clock and `FakeSlack` (`src/api/harness.ts`). Files and what they cover:

| file | ids |
| --- | --- |
| `src/api/courses.test.ts` | R1, R2 (and the table-driven check that every teacher route returns 404 for another teacher and changes no row), R3, R5, R6, R26 to R29, delete, bad JSON / content type / huge body / malformed ids, token never in bodies or logs |
| `src/api/flashcards.test.ts` | R4, R7, R12, R13, R14, R21, concurrent adds get distinct positions |
| `src/api/class.test.ts` | R8, R15 to R17, R18 (simulated), S40, S45 |
| `src/api/progress.test.ts` | R22 to R25 (R23 simulated), S20, rounding, per-card list |
| `src/api/student.test.ts` | R9 to R11, R19 |
| `src/services/auth.test.ts` | token hash, reissue revokes, student email refused; no `new Date()` / `Date.now` in the new services and routes |

## Slack handlers

| id | case | expected |
| --- | --- | --- |
| H1 | `ack()` is called before any await on services | yes |
| H2 | button values never contain the correct answer | assert on built blocks |
| H3 | malformed value: not a string, invalid JSON, wrong shape, negative or non-integer `o`, unknown `r`; for both `answer_*` and `rate_*` | no throw, `ack()` already called, a warning logged, service not called, message unchanged |
| H4 | click by a user who does not own the card (another student's delivery, an unenrolled or unknown Slack user, a payload with someone else's card id) | rejected with the text of its code, no review, the owner's card still open |
| H5 | right answer first click | rating buttons shown, no state change |
| H6 | rating click | calculator called, message replaced with no buttons |
| H7 | wrong or Don't know | right answer and material shown |
| H8 | action id regex | `answer_1..3`, `answer_dont_know`, `rate_*` all routed |
| H9 | card with 9 options | text and labels within limits |
| H10 | `rate_*` click | routed to `onRating`; `isCorrect` recomputed on the server from `o`; calculator called once with the rating |

## Image cards (Task 8b)

`src/render/render.test.ts`. Decision [0033](decisions/0033-image-cards.md). No golden hash: cross-platform byte equality is not claimed, so pixel properties are asserted.

| id | case | expected |
| --- | --- | --- |
| R1 | render a short question | PNG signature, 1200x630, white background, some ink, the same bytes on a second run |
| R2 | wrapping and shrinking with a fake measure | no line wider than the box, a very long word is cut, font from 64 px down in steps of 2, never below 28, null when it cannot fit |
| R3 | the 500 limit | 500 characters pass, 501 give `question_too_long`; counted in code points; stripped characters do not count; 500 capital W do not fit and give `question_too_long` |
| R4 | control, zero-width and bidi characters | removed, spaces and blank lines collapsed; combining marks without a base dropped, at most 2 per base; only invisible characters give `empty_question` |
| R5 | glyph pre-check | Russian, Ukrainian (ї є і ґ) and German umlauts accepted; emoji, Arabic, Chinese and Hebrew give `unsupported_character` |
| R6 | `glyphs.ts` against the font | the committed ranges equal the cmap of `Inter.ttf` (fontkit) |
| R7 | all ink inside the margins, hostile input too | decoded PNG: non-white pixels within 80 px margins (2 px tolerance) for the samples, a long single word, many combining marks, blank lines, 400 narrow characters |
| R8 | every sample renders | short, long, Russian, Ukrainian, umlauts |

Manual: `npm run render:samples` writes `reports/samples/*.png` (gitignored) to look at; `npm run font:vendor -- --check` verifies the font hashes. P1 to P4 (`src/slack/spikeProbe.test.ts`, spike helpers): the image block has exactly `type`, `slack_file`, `alt_text`; `invalid_blocks` is retried with the 0.5, 1, 2 s backoff (fake timers) and the waited time is reported; the post gives up after 15.5 s and says it never worked; other errors are not retried; `files.info` summaries and printed blocks hold no url. Sending and limits (Stage B, [decision 0034](decisions/0034-image-cards-stage-b.md)); R9 is `checkQuestion` in `render.test.ts`.

| id | where | case | expected |
| --- | --- | --- | --- |
| R4b | `src/api/flashcards.test.ts` | question of 501 characters, 500 capital W, an emoji, Arabic, Chinese, only invisible characters; exactly 500 characters; cleaning | 400 `question_too_long` / `unsupported_character` / `empty_question`, `Card 2: ...`, no text echoed, nothing stored; 500 pass; invisible characters and spaces removed from the stored text |
| W1 | `src/slack/web.test.ts` | image post | upload (private, no `channel_id`), then wait, then post with blocks `image, section, actions`, `text` = question plus options, `alt_text` set |
| W2 | same | `invalid_blocks` | retried with 0.5/1/2 s steps; the file is uploaded once; after the whole backoff (15.5 s) `CardImageError not_ready` |
| W3 | same | other Slack errors, upload failure, no file id | not retried; `SlackPortError` / `CardImageError upload_failed` / `no_file_id`; nothing posted; no token or bytes in the log |
| I1 | `src/services/scheduler.test.ts` | `sendNext` | image 1200x630 PNG, alt = question, text unchanged, blocks without the question |
| I2 | same | `CardImageError` (each code) | text card posted with the question, short code logged, delivery recorded |
| I3 | same | a stored question that cannot be drawn | text card, `unsupported_character` logged |
| I4 | same | Slack down on the image post, then the stale-claim re-send | the error propagates, claim stays, the re-send carries the image |
| I5 | same | `dm()` text | no image |
| H11 | `src/slack/handlers.test.ts` | rating prompt and right outcome on an image message | same image block sent back with the id only (never the url), then `section` |
| H12 | same | wrong outcome; text card; url-only file; unreadable image block | image kept; replaced as before; url sent; text only plus the logged code `image_ref_unreadable` |
| H13 | same | refusals (not open, sent again) | text only, image dropped |
| T-IMG-1 | `src/trace/recorder.test.ts` | postCard with an image | `<image 1200x630>` and alt recorded, no bytes, no base64 or hex of them |
| M4b | `src/mcp/tools.test.ts` | `add_flashcards` description | 500 characters, image, supported characters, the three codes, long context in options or material |
| S-IMG | `scripts/scenario.ts` | cards through the scheduler | 1200x630 PNG, alt = the question in the text; the stale-claim re-send carries the image; start text has none |

The real Slack questions are answered by the user-run spike ([slack/live-run.md](slack/live-run.md#image-card-spike)).

## MCP

| id | case | expected |
| --- | --- | --- |
| M1 | each tool calls the mapped route with the token | one test per tool in the table |
| M2 | API 4xx | tool result has `isError` |
| M3 | invalid input | rejected by zod before the HTTP call |
| M4 | start and stop descriptions mention notifications; update and delete flashcard say draft only | yes |
| M5 | `start_course`, `stop_course`, `delete_course`, `remove_student` without `confirmed: true` (omitted, false, `"true"`, 1, null, an array, an extra key next to true) | `isError`, no HTTP call; the flag is never sent to the API |
| M6 | `start_course` description: the user's explicit request to start is the confirmation, call at once with `confirmed: true`, no second approval; it no longer orders `list_flashcards` first ([decision 0036](decisions/0036-start-course-no-second-approval.md)) | yes (wording test) |
| M7 | no token in any tool result or error: API message that echoes it, fetch error with the URL and token inside, a timeout; redirects are not followed; the config check never prints a value or a URL with credentials | yes |
| M8 | smoke (`src/mcp/smoke.test.ts`): the real stdio server as a child process against the real REST app on `retain_test`: 16 tools; one call per family (courses, flashcards, students, progress); `start_course` without the flag refused and nothing posted, with it the course is active and students are messaged; second start is `isError` `course_not_draft`; `update_flashcard` on the running course is `course_not_draft`; a wrong token is `unauthorized` | yes |
| M9 | the server refuses to start without `RETAIN_API_URL`, without `RETAIN_API_TOKEN`, or with credentials in the URL: exit 1, the variable named on stderr, no value printed | yes |
| M10 | stdout of the child holds only JSON-RPC messages: every line parses (also on the refusal path, where it is empty) | yes |
| M11 | the tool table in `mcp-teacher-api.md` lists the same names as `src/mcp/tools.ts` | yes |

## Non-functional checks

- Load script: 1,000 students, scheduler tick with a fake Slack that sleeps; assert sequential sending and no rejected promise.
- Typecheck with `strict`; lint rule or grep forbidding `any`.
- Env validation: missing variable stops startup with a clear message.

## Exit criteria per Roadmap task

Each task ends with passing tests where it makes sense and a commit. Task 3 is done when C1 to C23 and A1 to A9 pass. The `due` clamp (S37, S49 to S52) belongs to the answer service, Task 5. Task 6 is split in three commits: 6a (core, built), 6b-1 (daily tick), 6b-2 (reminders, stale-claim recovery, cleanup); each S case has one owner in the table below ([decision 0026](decisions/0026-task6-scheduler-choices.md)).

| task | test ids |
| --- | --- |
| 1 Project setup | R20 (env validation; already in `src/config/env.test.ts`) |
| 3 Calculator | C1 to C23, A1 to A9 |
| 4 Schema and repositories | D1 to D12 |
| 5 Answer service | S2 to S4, S10, S13, S14, S31, S33, S34, S37, S41, S49 to S52; for S3, S10 and S34 only the service part (below) |
| 6a Scheduler core | S1, S3 and S4 (rest), S5 to S11, S15 to S17, S21 to S30 (S28: `finishEndedCourses` called directly), S34 (rest), S36, S38, S39 (course part), S42, S46, S53; first cards at start and enrollment; the S51 regression (answered on the last review day, not selected again); the S11 race on real Postgres |
| 6b-1 Daily tick | S19, S12; the tick completes the course at `ends_at`; a repeated tick sends nothing new; S39 (tick part); both Zurich DST days (2026-03-29, 2026-10-25); a student without a Slack id; failure isolation; `startTick` overlap and `stop()` (one real 20 ms interval); `localHour` for Zurich, Kolkata and New York |
| 6b-2 Reminders, cleanup | S18, S32, S33, S35, S43, S44, S47, S48; reviews and re-enrollment ([decision 0026](decisions/0026-task6-scheduler-choices.md)) |
| 7 REST API | R1 to R11; also R12 to R19, R21 to R29, S20, S40, S45 (class progress needs the progress endpoint) |
| 8a Slack wiring | H1 to H10 against the real services and `FakeSlack` (`src/slack/handlers.test.ts`, `card.test.ts`); the adapter against a stub client (`web.test.ts`); live-only checks in [live-run.md](slack/live-run.md) |
| 9 MCP | M1 to M11 |

Split of S3, S10 and S34 ([decision 0025](decisions/0025-task5-answer-service-choices.md)): Task 5 checks the answer service part. S3: status `exempt`, score 100, `assessment_done_at` set, no card left open; "no cards" and "progress 100" are checked with `next()` (Task 6) and the progress endpoints (Task 7). S10: `sent_at` cleared and the review stored; "next card sent" is checked in Task 6. S34: one review for the delivery; "next card follows" is checked in Task 6. S16 (completion on the last learned card) is Task 6a: `afterAnswer` in `src/services/scheduler.ts` calls `completeIfLearned` after every answer.

Assignment reasons: S31, S33, S34, S41 are answer-service checks on a click (no review stored, no state change), like S13 and S14; S42 is `next()` selection; S20 is the progress endpoints and S40 is the removal route, both in the REST API.
