# REST API

Replaces the API part of the old `data-model-and-api.md` (deleted from the working tree; still in git history). Bodies are JSON, field names snake_case, dates ISO 8601, options 0-based. Each request body is validated with zod at the route ("routes → services → db"). Routes stay thin.

Auth: `Authorization: Bearer <token>`. Middleware maps the token to a teacher (`users.api_token_hash`) and sets `teacher_id`. A teacher only sees their own courses. Errors: `{ "error": { "code": "string", "message": "string" } }` with 400, 401, 403, 404, 409.

## Courses (teacher)

| Method and path | Body or result |
| --- | --- |
| `POST /courses` | `{ title, material_url, ends_at, scheduled_start_at?, assessment_pass_threshold? }` creates a `draft`; `ends_at` is required |
| `GET /courses` | list with `card_count`, `assessment_card_count`, `student_count` |
| `GET /courses/:courseId` | one course, same shape |
| `PATCH /courses/:courseId` | any of `title, material_url, scheduled_start_at, ends_at, assessment_pass_threshold`; `draft` and `active` only (`finished`: 409 `course_finished`). On an `active` course `assessment_pass_threshold` cannot be changed (409 `threshold_locked`) and `ends_at` can only be moved later (409 `ends_at_shortened` if the new value is earlier than the current one). |
| `POST /courses/:courseId/start` | `draft` to `active`; DM to enrolled students. 409 if there are no cards. |
| `POST /courses/:courseId/stop` | `active` to `finished`; active enrollments become `completed` ([decision 0011](decisions/0011-enrollment-completed.md)); DM to students |
| `DELETE /courses/:courseId` | `draft` only; otherwise 409 (use stop) |

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

> Disabled by default ([decision 0018](decisions/0018-student-routes-dev-only.md)). Both routes below have no authentication, so they are mounted only when `STUDENT_ROUTES_ENABLED=true`, and the server refuses to start with that flag in production (`NODE_ENV=production`). Until student auth exists they are for development and tests; students answer through Slack.

`POST /users/:userId/flashcards/:flashcardId/reviews`

```json
{ "chosen_option": 1, "rating": "medium" }
```

- `chosen_option`: integer or `null` ("Don't know").
- `rating` required when the answer is right; ignored when wrong or null. Missing on a right answer: 400, never a default ([decision 0004](decisions/0004-right-answer-requires-rating.md)).
- Response: `{ is_correct, correct_option, rating, material_url, progress }`. `correct_option` is revealed only after the answer.

`GET /users/:userId/courses` returns `{ courses: [{ course_id, title, status, progress, assessment_done, enrollment_status }] }`.

Slack handlers call the same review service directly, not this route ([slack/integration.md](slack/integration.md)). The MVP has no student REST login, so these two routes exist for development, tests and later clients; see the note above.
