# REST API

Replaces the API part of the old `data-model-and-api.md` (deleted from the working tree; still in git history). Bodies are JSON, field names snake_case, dates ISO 8601, options 0-based. Each request body is validated with zod at the route ("routes → services → db"). Routes stay thin.

Built in Task 7 ([decision 0028](decisions/0028-task7-rest-api-choices.md)): `src/api/` (routes), `src/services/` (rules), `src/db/` (queries). `createApp(deps)` in `src/api/app.ts` returns the Express app and does not listen.

Auth: `Authorization: Bearer <token>`. Middleware hashes the token (SHA-256) and looks up the teacher (`users.api_token_hash`, role `teacher`); a miss is 401. A teacher only sees their own courses: another teacher's course, flashcard or student is **404, never 403**. Errors: `{ "error": { "code": "string", "message": "string" } }` with 400, 401, 404, 409 (and 500 `internal`). Ids in paths are uuids; a malformed id is 404. Unknown routes are 404 in the same shape. A token is never logged or echoed in an error body. Bodies are strict: an unknown key is 400. Field names for ids are `course_id`, `student_id`, `flashcard_id`; lists are wrapped (`{ courses: [...] }`, `{ flashcards: [...] }`, `{ students: [...] }`).

## Courses (teacher)

| Method and path | Body or result |
| --- | --- |
| `POST /courses` | `{ title, material_url, ends_at, scheduled_start_at?, assessment_pass_threshold? }` creates a `draft`; `ends_at` is required |
| `GET /courses` | list with `card_count`, `assessment_card_count`, `student_count` |
| `GET /courses/:courseId` | one course, same shape |
| `PATCH /courses/:courseId` | any of `title, material_url, scheduled_start_at, ends_at, assessment_pass_threshold`; `draft` and `active` only (`finished`: 409 `course_finished`). On an `active` course `assessment_pass_threshold` cannot be changed (409 `threshold_locked`) and `ends_at` can only be moved later (409 `ends_at_shortened` if the new value is earlier than the current one). |
| `POST /courses/:courseId/start` | `draft` to `active` (`starts_at` = now); DM to enrolled students, then the first assessment card at once. 409 `no_cards` if there are no cards, 409 `ends_at_passed` if `ends_at` is not in the future, 409 `course_not_draft` otherwise |
| `POST /courses/:courseId/stop` | `active` to `finished`; `active` enrollments become `completed` ([decision 0011](decisions/0011-enrollment-completed.md)) and get the final-progress DM; `exempt` and removed students get nothing. 409 `course_not_active` if the course is not running |
| `DELETE /courses/:courseId` | `draft` only; otherwise 409 `course_not_draft` (use stop). Deletes its flashcards and enrollments (removed ones too). 204 |

Course `PATCH` errors (shape `{ "error": { "code", "message" } }`, test cases R26 to R29 in [test-plan.md](test-plan.md)):

| Code | Status | When | Reason |
| --- | --- | --- | --- |
| `threshold_locked` | 409 | `assessment_pass_threshold` is in the body of a `PATCH` on an `active` course | The assessment has run or is running; changing the threshold would change who is exempt |
| `ends_at_shortened` | 409 | `ends_at` is earlier than the current value on an `active` course | The new-cards-per-day quota is computed from the remaining days; shortening would push students past the end. Extending is allowed |
| `course_finished` | 409 | any `PATCH` on a `finished` course | A finished course is read-only |

## Flashcards (teacher)

| Method and path | Body or result |
| --- | --- |
| `POST /courses/:courseId/flashcards` | `{ flashcards: [{ question, options, correct_option, material_url?, is_assessment }] }`; 201 with ids. `draft` and `active` only. On an `active` course `is_assessment` must be false (400 `assessment_closed`). `position` defaults to the end. |
| `GET /courses/:courseId/flashcards` | list for the teacher, includes `correct_option` |
| `PATCH /flashcards/:flashcardId` | `{ is_assessment?, position?, material_url? }`; `draft` courses only. `is_assessment` can be changed only while the course is `draft`, as in the MCP tools. |
| `DELETE /flashcards/:flashcardId` | `draft` courses only |

[Decision 0016](decisions/0016-flashcards-frozen-after-start.md): editing and deleting cards, including marking or unmarking assessment, is allowed only while the course is `draft`. After `start` the API returns 409 `course_not_draft`; only adding new cards is allowed (not on a `finished` course: 409 `course_finished`). Question and options of a card are never editable through `PATCH`. Cards added to an `active` course never reopen a `completed` enrollment.

Validation: 2 to 9 options, `correct_option` inside the range, button labels are only numbers so option text length is bounded by Slack message text (under 3,000 chars per card).

## Class (teacher)

| Method and path | Body or result |
| --- | --- |
| `POST /courses/:courseId/students` | `{ students: [{ email, name }] }`. Creates missing users, enrolls, looks up `slack_id`. Result lists `{ email, enrolled, slack_matched, restored }` per student. Enrolling an email that was removed less than `REMOVED_RETENTION_DAYS` ago clears `removed_at` and restores its progress (`restored: true`). |
| `GET /courses/:courseId/students` | `{ students: [{ student_id, email, name, status, enrolled_at, assessment_done_at, slack_matched }] }`; removed students are not listed |
| `DELETE /courses/:courseId/students/:studentId` | soft delete: sets `enrollments.removed_at`. 204; repeating it changes nothing. |

[Decision 0017](decisions/0017-enrollment-soft-delete.md): from `removed_at` the student gets no cards or reminders, is excluded from class progress, `student_count`, this list and `GET /users/:userId/courses`, and any open Slack card message is replaced with "expired". Re-enrolling within 14 days (`REMOVED_RETENTION_DAYS`) restores all progress. After 14 days a daily cleanup hard-deletes the enrollment, `card_states` and `reviews` of that course; the user row stays.

A student added to an `active` course gets the first assessment card at once, not at the next `SEND_HOUR` tick ([scheduler.md](scheduler.md#when-a-card-is-sent)).

## Progress (teacher)

`GET /courses/:courseId/progress`

```json
{ "course_id": "…", "class_progress": 42.5,
  "students": [{ "student_id": "…", "name": "Ann", "status": "active",
                 "progress": 40, "learned": 4, "total": 10, "assessment_done": true,
                 "waiting_since": "2026-01-07T09:00:00Z" }] }
```

`waiting_since` is the `sent_at` of the student's open card, or null when no card is open. After `MAX_REMINDERS` reminders an unanswered card blocks that student ([scheduler.md](scheduler.md#unanswered-cards)); a `waiting_since` that is many days old is how the teacher sees it. Removed students are not listed.

`GET /courses/:courseId/students/:studentId/progress` returns the same fields including `waiting_since`, and adds `cards: [{ flashcard_id, question, learned, correct_streak, due, last_answer_correct }]`.

## Student answers

> Disabled by default ([decision 0018](decisions/0018-student-routes-dev-only.md)). Both routes below have no authentication, so they are mounted only when `STUDENT_ROUTES_ENABLED=true`, and the server refuses to start with that flag in production (`NODE_ENV=production`). They are also mounted **only when the server binds to a loopback host** (`localhost`, `127.0.0.1`, `::1`), whatever `NODE_ENV` says: `createApp` takes the bind host (`bindHost`, required) and checks it in one place (`assertStudentRoutesAllowed` in `src/api/loopback.ts`); `startServer` (`src/api/server.ts`) listens on that same host and, with the flag on, verifies the address the socket really got. `STUDENT_ROUTES_ENABLED=true` with any other host (`0.0.0.0`, `::`, a LAN name) fails at startup with a message naming the variable and the host ([decision 0028](decisions/0028-task7-rest-api-choices.md#amendment-student-routes-only-on-a-loopback-host)). Until student auth exists they are for development and tests; students answer through Slack.

`POST /users/:userId/flashcards/:flashcardId/reviews`

```json
{ "chosen_option": 1, "rating": "medium" }
```

- `chosen_option`: integer or `null` ("Don't know").
- `rating` required when the answer is right; ignored when wrong or null. Missing on a right answer: 400, never a default ([decision 0004](decisions/0004-right-answer-requires-rating.md)).
- Response: `{ is_correct, correct_option, rating, material_url, progress }`. `correct_option` is revealed only after the answer.

`GET /users/:userId/courses` returns `{ courses: [{ course_id, title, status, progress, assessment_done, enrollment_status }] }`.

Slack handlers call the same review service directly, not this route ([slack/integration.md](slack/integration.md)). The MVP has no student REST login, so these two routes exist for development, tests and later clients; see the note above.

## Error codes

One table for the whole API (decision 0028). Codes marked * are not named anywhere else in the docs; they are the names chosen in Task 7.

| code | status | where | test |
| --- | --- | --- | --- |
| `unauthorized`* | 401 | no, malformed or unknown bearer token on a teacher route | R1 |
| `not_found` | 404 | unknown, malformed or other teacher's id; unknown route; a student route while `STUDENT_ROUTES_ENABLED` is off; a removed or never-enrolled student | R2, R19, R15 |
| `invalid_request`* | 400 | any body that fails validation (also bad JSON, wrong content type, a body over 1 MB); `correct_option` outside the options; a missing `ends_at` | R3, R4 |
| `assessment_closed` | 400 | `POST` flashcards with `is_assessment: true` on an `active` course | R13 |
| `rating_required`* | 400 | review: right answer without `rating` ([decision 0004](decisions/0004-right-answer-requires-rating.md)) | R9 |
| `invalid_option`* | 400 | review: `chosen_option` is not an option of the card | R9 |
| `course_not_draft` | 409 | patch or delete a flashcard on an `active` or `finished` course; delete or start a course that is not a draft | R7, R12, R14, R21 |
| `course_finished` | 409 | `PATCH` a finished course; add cards to or enroll students in a finished course | R14, R29 |
| `threshold_locked` | 409 | `assessment_pass_threshold` in the body on an `active` course (even the same value) | R26 |
| `ends_at_shortened` | 409 | `ends_at` earlier than the current value on an `active` course (equal is accepted) | R27 |
| `no_cards`* | 409 | start with zero cards | R5 |
| `course_not_active`* | 409 | stop a course that is a draft or finished | R6 |
| `ends_at_passed`* | 409 | start a course whose `ends_at` is not in the future | R6 |
| `not_open`, `not_enrolled`, `removed`, `course_over`, `sent_again`, `duplicate`* | 409 | review refused by the answer service ([decision 0025](decisions/0025-task5-answer-service-choices.md)); nothing is stored | R11 |
| `internal`* | 500 | anything unexpected; the body has no details | |

`PATCH` course checks in this order: `course_finished`, `threshold_locked`, `ends_at_shortened`. Status 403 is not used.

## Try it with curl

Development only. `npm run api` starts the API on `127.0.0.1:3000` (set `PORT` to change it) with a Slack port that prints messages to the console and no scheduler tick; nobody is matched in Slack, so students show `slack_matched: false`. It is separate from the server Task 8 will wire in `src/index.ts`.

```bash
npm run db:up && npm run db:reset          # local Postgres, DATABASE_URL in .env
npm run teacher:token -- tom@example.com "Tom"   # prints a token once; run it again to replace the token
npm run api
```

```bash
TOKEN=...   # the printed token
curl -s -X POST http://127.0.0.1:3000/courses -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Security basics","material_url":"https://example.com/m","ends_at":"2026-12-20T22:59:00Z"}'
curl -s http://127.0.0.1:3000/courses -H "Authorization: Bearer $TOKEN"
```
