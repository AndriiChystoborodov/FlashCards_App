# 0018. Student REST routes are enabled only in development and tests

## Context

`POST /users/:userId/flashcards/:flashcardId/reviews` and `GET /users/:userId/courses` have no authentication: the MVP has no student login, and students answer through Slack, which calls the review service directly. Anyone who can reach these routes could answer for any `:userId`.

## Choice

Until student authentication exists, the two routes are mounted only when `STUDENT_ROUTES_ENABLED=true`. The default is false. The zod env schema refuses `STUDENT_ROUTES_ENABLED=true` together with `NODE_ENV=production`, so the server does not start with the flag set in production. When the flag is off the routes do not exist (404). Chosen by the user on 2026-10-24.

## Why

It closes an unauthenticated write path in production without removing the routes that tests and local scripts use. The route and the Slack handlers share one review service, so tests of the route also cover the answer logic.

## Consequences

- Add `STUDENT_ROUTES_ENABLED` to `.env.example` and the env validation in Task 1.
- Teacher routes are unaffected (bearer token, [decision 0014](0014-teacher-token-hashed.md)).
- Student authentication, when it comes, replaces this flag with a real check that `:userId` is the caller.
