# REST API

Replaces the API part of the old `data-model-and-api.md` (deleted from the working tree; still in git history). Bodies are JSON, field names snake_case, dates ISO 8601, options 0-based. Each request body is validated with zod at the route ("routes → services → db"). Routes stay thin.

Auth: `Authorization: Bearer <token>`. Middleware maps the token to a teacher (`users.api_token_hash`) and sets `teacher_id`. A teacher only sees their own courses. Errors: `{ "error": { "code": "string", "message": "string" } }` with 400, 401, 403, 404, 409.

## Courses (teacher)

| Method and path | Body or result |
| --- | --- |
| `POST /courses` | `{ title, material_url, ends_at, scheduled_start_at?, assessment_pass_threshold? }` creates a `draft`; `ends_at` is required |
| `GET /courses` | list with `card_count`, `assessment_card_count`, `student_count` |
| `GET /courses/:courseId` | one course, same shape |
| `PATCH /courses/:courseId` | any of `title, material_url, scheduled_start_at, ends_at, assessment_pass_threshold`; `draft` and `active` only |
| `POST /courses/:courseId/start` | `draft` to `active`; DM to enrolled students. 409 if there are no cards. |
| `POST /courses/:courseId/stop` | `active` to `finished`; active enrollments become `completed` ([decision 0011](decisions/0011-enrollment-completed.md)); DM to students |
| `DELETE /courses/:courseId` | `draft` only; otherwise 409 (use stop) |

## Flashcards (teacher)

| Method and path | Body or result |
| --- | --- |
| `POST /courses/:courseId/flashcards` | `{ flashcards: [{ question, options, correct_option, material_url?, is_assessment }] }`; 201 with ids |
| `GET /courses/:courseId/flashcards` | list for the teacher, includes `correct_option` |
| `PATCH /flashcards/:flashcardId` | `{ is_assessment?, position?, material_url? }`; question and options are immutable once sent |
| `DELETE /flashcards/:flashcardId` | 409 once any student has the card |

Adding or deleting cards on a `finished` course returns 409. Cards added to an `active` course never reopen a `completed` enrollment.

Validation: 2 to 9 options, `correct_option` inside the range, button labels are only numbers so option text length is bounded by Slack message text (under 3,000 chars per card).

## Class (teacher)

| Method and path | Body or result |
| --- | --- |
| `POST /courses/:courseId/students` | `{ students: [{ email, name }] }`. Creates missing users, enrolls, looks up `slack_id`. Result lists `{ email, enrolled, slack_matched }` per student. |
| `GET /courses/:courseId/students` | `{ students: [{ student_id, email, name, status, enrolled_at, assessment_done_at, slack_matched }] }` |
| `DELETE /courses/:courseId/students/:studentId` | remove an enrollment |

A student added to an `active` course gets the first assessment card at once, not at the next `SEND_HOUR` tick ([scheduler.md](scheduler.md#when-a-card-is-sent)).

## Progress (teacher)

`GET /courses/:courseId/progress`

```json
{ "course_id": "…", "class_progress": 42.5,
  "students": [{ "student_id": "…", "name": "Ann", "status": "active",
                 "progress": 40, "learned": 4, "total": 10, "assessment_done": true }] }
```

`GET /courses/:courseId/students/:studentId/progress` adds `cards: [{ flashcard_id, question, learned, correct_streak, due, last_answer_correct }]`.

## Student answers

`POST /users/:userId/flashcards/:flashcardId/reviews`

```json
{ "chosen_option": 1, "rating": "medium" }
```

- `chosen_option`: integer or `null` ("Don't know").
- `rating` required when the answer is right; ignored when wrong or null. Missing on a right answer: 400, never a default ([decision 0004](decisions/0004-right-answer-requires-rating.md)).
- Response: `{ is_correct, correct_option, rating, material_url, progress }`. `correct_option` is revealed only after the answer.

`GET /users/:userId/courses` returns `{ courses: [{ course_id, title, status, progress, assessment_done, enrollment_status }] }`.

Slack handlers call the same review service directly, not this route ([slack/integration.md](slack/integration.md)). A student user is allowed to call only their own `:userId`; the MVP has no student REST login, so these two routes are for tests and later clients.
