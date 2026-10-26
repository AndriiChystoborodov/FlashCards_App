# 0028. REST API (Roadmap Task 7): choices the docs left open

Source: the user approved the Task 7 plan, with two answers and several additions (relayed by the session that started the build), 2026-10-26. Follows [rest-api.md](../rest-api.md), [0014](0014-teacher-token-hashed.md), [0016](0016-flashcards-frozen-after-start.md), [0017](0017-enrollment-soft-delete.md), [0018](0018-student-routes-dev-only.md).

## Answers to the plan's questions

1. **403 is never emitted.** Another teacher's course, flashcard or student is 404 (R2). `rest-api.md` no longer lists 403.
2. **Stop messages go to `active` enrollments only.** `finishCourse` (Task 6a) completes and notifies `active` enrollments; `exempt` and removed students get nothing, as decision 0011 and the scenario already assume. `integration.md` and `rest-api.md` say "active enrollments" now.

## Choices

| # | choice | why |
| --- | --- | --- |
| 1 | Express 5.3.0 and `@types/express` 5.0.6 become direct dependencies (they were only Bolt's); the app is `createApp(deps)` in `src/api/app.ts`, which does not listen. `ApiDeps` = `SchedulerDeps` + `removedRetentionDays` + `studentRoutesEnabled` | same versions, so no second copy; tests, the scenario and Task 8 choose host and port |
| 2 | `src/index.ts` is unchanged: there is no real `SlackPort` until Task 8. `npm run api` (`scripts/dev-api.ts`, development only, `127.0.0.1`, Slack messages printed to the console, no tick) is the only server; it is separate from the code Task 8 wires | the user can try routes with curl without the Task 8 code |
| 3 | Tests and the scenario call the app over real HTTP with Node's `fetch` on `127.0.0.1:0` (`src/api/testClient.ts`), not supertest | one dependency fewer; the same helper serves the scenario |
| 4 | Layers: `src/api/*` parse (zod) and serialize, `src/services/*` hold the rules and throw `ServiceError(code)`, `src/api/errors.ts` maps code to status (the table in rest-api.md), `src/db/*` query | AGENTS.md: routes, services, db |
| 5 | Ownership: every teacher service starts from the owning teacher's id (`ownedCourse`, or `lockCourse` and a `teacherId` check; a flashcard is checked through its course). Another teacher's id is `not_found`. A table-driven test calls every teacher route with another teacher's token and compares the database rows before and after | R2 |
| 6 | Auth: `Bearer <20 to 200 url-safe chars>`, SHA-256, lookup by hash on role `teacher`; only `/courses` and `/flashcards` paths are authenticated, so an unknown or disabled route is 404, not 401 (R19). The token is 32 `crypto.randomBytes` (base64url), printed once by `npm run teacher:token`, never stored or logged; reissuing replaces the hash; a student email is refused | decision 0014 |
| 7 | Errors never contain input values: zod messages are built from path and issue text, 500s log only the error name, code and driver message, bodies carry no stack. A test scans bodies and captured console output for the token | the user's addition |
| 8 | New codes (marked in rest-api.md): `unauthorized`, `invalid_request`, `no_cards`, `course_not_active`, `ends_at_passed`, `rating_required`, `invalid_option`, `internal`, and the answer-service reasons as 409 codes | the docs gave statuses but no names for these rules |
| 9 | Body rules: strict objects (unknown key = 400); 1 MB JSON limit and `application/json` only (400 otherwise); at most 100 cards per call, 500 students per call; `question` + options at most 3,000 characters; 2 to 9 options; threshold integer 1 to 100; dates ISO 8601 with a zone; `material_url` http(s); an empty `PATCH` is 400 | rest-api.md "Validation", Slack limits |
| 10 | Malformed uuids are 404 | the same answer as an unknown id; no database error |
| 11 | `PATCH` course: one transaction under `SELECT ... FOR UPDATE` on the course; order of checks `course_finished`, `threshold_locked`, `ends_at_shortened`; `threshold_locked` applies when the field is present, even with the same value; an equal `ends_at` is accepted. Start, flashcard add/patch/delete and delete take the same lock | no race between start and edits |
| 12 | Start: draft only, `ends_at` in the future (`ends_at_passed`), at least one card (`no_cards`); sets `starts_at`; DMs every present `active` student with a Slack id, then `sendFirstCards`. `scheduled_start_at` is only stored; nothing starts a course by itself | scheduler.md has no auto-start |
| 13 | Stop is `finishCourse` (Task 6a). Delete cascades flashcards and enrollments in one transaction | decision 0011, decision 0017 |
| 14 | Flashcards: positions are 1..n; new cards go to the end (`max + 1`) under the course lock; `PATCH position` moves the card and renumbers the course; ids in responses are `flashcard_id` and `position` | the quota and assessment order use `position`; ties would be unpredictable |
| 15 | Enrollment: emails are trimmed and lower-cased, duplicates in one call are dropped (first wins), existing users keep their name; a Slack lookup that throws counts as unmatched; an already enrolled student gives `enrolled: false`; the first card goes out at once on an `active` course; a finished course is 409 `course_finished` | rest-api.md "Class" |
| 16 | Restore: within `REMOVED_RETENTION_DAYS` the row is restored (`restored: true`), the student gets "you are enrolled again" and the voided card is sent again at once; a removal older than that is cleaned up first (`hardDeleteEnrollment`, the same function the daily job will use in 6b-2) and enrolled fresh | decision 0017; the job is 6b-2 |
| 17 | Removal: `softRemoveEnrollment` under the enrollment lock, the open card voided (`sent_at`, `message_ts`, `reminded_at`, `reminder_count` cleared), the message replaced with "expired" after the commit (a Slack failure is logged); repeating changes nothing; a student who was never in the course is 404 | decision 0017 |
| 18 | Progress: completed = `completed_progress`, exempt = 100, active = learned / total (0 with no cards), rounded to 2 decimals; class = mean over present enrollments (0 when empty); three grouped queries per call, not one per student; `waiting_since` = `sent_at` of the open card | data-model.md "Derived values"; 1,000 students |
| 19 | Student routes: `POST .../reviews` runs `submitAnswer` then `afterAnswer` (like a Slack click, so the student gets the next card), maps the answer service's errors and refusals to codes, and answers `{ is_correct, correct_option, rating, material_url, progress }` (progress in the card's course); `GET /users/:userId/courses` lists present enrollments; an unknown user is 404 | decision 0018; the card is never fetched before the answer, so `correct_option` cannot leak |
| 20 | `dm` is exported from `scheduler.ts`; `TEXT` gains `started`, `restored`, `removed` ("expired") | the services send the same way the scheduler does |
| 21 | Time comes only from `deps.clock` (tests grep the new files for `new Date()` and `Date.now`) | the Clock rule |

## Not done

- `GET /users/:userId/courses` and the review route have no authentication (decision 0018): off by default, refused in production by the env schema.
- No rate limit, CORS, request logging or pagination (AGENTS.md: none for now).
- Teachers cannot list removed students (decision 0017).

## Review and attack round (two independent subagents, before the commit)

A reviewer read the diff for authorization and leaks (no cross-teacher path, no pre-answer `correct_option` leak found). A second agent attacked the routes with throwaway scripts outside the repo (malformed input, boundaries, parallel start/patch/enroll/remove/stop, replayed reviews). Fixed, each with a regression test:

| finding | decision |
| --- | --- |
| Enrolling a teacher's email made the teacher a student of the course and revealed their Slack match | skipped: `enrolled: false`, no Slack lookup; test in `class.test.ts` |
| Enrollment checked the course status without a lock | the insert now runs under the course lock and re-reads the status; stopped or deleted meanwhile gives 409 / 404 |
| JSON was parsed before authentication | `express.json` runs after `authenticate` on teacher paths (1 MB) and on `/users` (10 KB); a bad body without a token is 401 |
| NUL bytes in text gave 500 (Postgres) | rejected as 400 in every free-text field and URL |
| `ends_at` of year 0 or 1 gave 500 | dates outside 2000 to 9999 are 400 |
| A bad percent-encoding in a path and a broken gzip body gave 500 | 404 (malformed id) and 400 |
| Parallel re-enrollments of a removed student all reported `restored` and sent several DMs | `restoreEnrollment` is conditional and returns whether it changed the row; one wins |
| Server logs of Slack errors printed whole error objects | name and the first 200 characters of the message only |

Accepted and written down:

- Enrolling a large batch while the course is stopped at the same moment can answer 409 `course_finished` after some students were already enrolled (they are `completed` with the stop). Each student is its own transaction.
- `STUDENT_ROUTES_ENABLED=true` is refused only with `NODE_ENV=production`; a deployment that forgets `NODE_ENV` would serve the open student routes (decision 0018 stays as decided).
- `scheduled_start_at` and a past `ends_at` on a draft are stored as given; only `start` checks `ends_at`. Whitespace-only questions, duplicate options and URLs with credentials are accepted.
- `slack_matched` tells a teacher whether an email has a Slack account; that is the feature.
