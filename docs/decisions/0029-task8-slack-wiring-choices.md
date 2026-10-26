# 0029. Slack wiring (Roadmap Task 8a): choices

Source: the user approved the Task 8a plan on 2026-10-26 with the proposed texts, the 2,900 cap and these additions: authorization of every click, no tokens or payloads in logs, no write and no `correct_option` on the first click of a right answer, a live-run note about stopping `npm run dev`, an independent review before the commit. 8b (image card) is not approved.

## Choices

| # | choice | why |
| --- | --- | --- |
| 1 | `slackPort(web)` in `src/slack/web.ts` over a narrow `SlackWebApi` (`chat.postMessage`, `chat.update`, `users.lookupByEmail`); scopes need no change | the services call only the port; a stub tests it |
| 2 | One `lookupByEmail` call returns the id and `tz`; `users.info` is not called | the response already has `tz` (checked in the installed types) |
| 3 | A Slack failure is `SlackPortError(method, code)` with only Slack's code (`channel_not_found`, `ratelimited`, `slack_webapi_request_error`, `unknown`); the client's own error is dropped | client errors can hold request details; messages never carry tokens |
| 4 | A failed post leaves the claim; the tick re-posts it (decision 0027). A permanent failure (user unreachable) re-fails every pass and blocks that student: known, logged only ([implementation-plan.md](../implementation-plan.md#risks-and-ideas)) | scope of 8a |
| 5 | Bolt client options: `fiveRetriesInFiveMinutes`, `timeout: 15000` | the default (ten retries over about 30 minutes, no timeout) could hold one send for half an hour |
| 6 | New migration `0001`: unique index on `users.slack_id` (nulls may repeat); `findUserBySlackId` | a click is mapped to a user by this id, so two users must not share one. The test suite had one test sharing `ULATE`; it uses a random id now |
| 7 | Authorization: the Slack user maps to our user (unknown: `not_enrolled`); `previewAnswer` and `submitAnswer` refuse unless that user is enrolled, the course and enrollment are active, the card is open for that user and `message.ts` is the stored one. Another student's payload, even with her card id, finds no open card of the clicker, or a different delivery (`sent_again`) | the card state is keyed by user; nothing is read from the payload except the card id and the chosen option |
| 8 | `previewAnswer` (answer service) shares `guardClick` with `submitAnswer` and writes nothing; a right first click replaces the message with the rating prompt (value: card id, chosen option, rating; never `correct_option`); wrong and "Don't know" go to `submitAnswer` at once | decision 0025 #2, H5 |
| 9 | The rating prompt reveals "Right." by design; before it no message or value holds the right option, and a refused click reveals nothing | H2 |
| 10 | Texts: `not_open` "This card was already answered."; `not_enrolled` "You are not enrolled in this course."; `course_over` "The course is over."; `duplicate` shows nothing; an unexpected error shows the ephemeral "Something went wrong. Please try again." with the buttons kept | the user approved them |
| 11 | Logs hold the clock time, the Slack user id, the action id, refusal codes and error names only; never a value, a payload or a token. The click log uses `deps.clock` (decision 0024 #8) | the user's rule |
| 12 | `escapeMrkdwn` on question, options and the material link in messages | `<!channel>`, `<@U..>` and links in teacher text must not fire in a DM |
| 13 | REST cap for question plus options is 2,900 characters (was 3,000): Slack's section block holds 3,000 and the card adds about 40 | H9 at the cap would fail otherwise |
| 14 | `index.ts`: `startServer` (host `HOST`, port `PORT`; the loopback check stays only in `createApp`), then Bolt, then `startTick`; SIGINT/SIGTERM stop the tick, Bolt, the server and the pool. `SLACK_MODE=http` throws "not built yet" | decision 0028 A1, A2, A6 |
| 15 | Env: `HOST` (default `127.0.0.1`), `PORT` (default 3000); `SLACK_APP_TOKEN` required only for socket mode; `SLACK_TEST_USER_ID` is needed only by the spike | the real server needs neither a test user nor an app token in http mode |
| 16 | The spike keeps its handlers in `spikeHandlers.ts`; `card.ts` `Rating` is the domain `Rating3` (decision 0021 #3) | `npm run spike` stays usable |
| 17 | `startTick` logs one line per pass | the user can see ticks |
| 18 | `npm run demo:seed -- <slack-email> [days]` (`scripts/demo-seed.ts`): refuses unless `assertDemoDatabase` (the reset's checks plus exactly `retain_dev`); in-process REST on a random loopback port with the real adapter; 9 cards, 3 assessment; reuses an existing demo course | the user's request |

## What ran against what

Everything in 8a was built and tested against the fake or a stub: `FakeSlack`, a stub Web client, real local Postgres.

**First live run (reported by the user, 2026-10-26; details in [live-run.md](../slack/live-run.md)).** Three assessment cards answered right + Easy, the student was exempt and received the "already know this material" message. Real Slack delivered the course start DM, the cards, the message replacement and the final DM within about a minute.
- **Verified against real Slack:** choice 1 (`chat.postMessage` for the DMs and cards, `chat.update` for the replacements), the right-answer and rating path, the exempt outcome and its DM; `users.lookupByEmail` by implication (the DM reached the matched user).
- **Still unverified against real Slack:** wrong answer and "Don't know", a double click and the "already answered" text, the 3-second ack, 10-option rendering, outage and 429 behaviour with choice 5's retry and timeout settings, `block_actions` retries, the tick (next-day cards, stale-claim recovery) and the stop DM, the time zone from `lookupByEmail`, an unknown email.
- A second run was mentioned by the user but its result was not reported; nothing from it is recorded.

## Independent review (subagent, before the commit)

Authorization, data leaks and the demo-seed guard: nothing blocking. Fixed after it: errors are logged by `errText` (name and 200 characters) in the tick and the scheduler, as the handlers and enrollment already did, so SQL parameters and Slack request data cannot reach the log; `shutdown` in `index.ts` tries every step, force-exits after 10 s and exits 1 on error; a failed startup closes the server and the pool. Left as they are: `demo:seed` prints the teacher token once by design; if a teacher edits `correct_option` between the two clicks the rating click shows the ephemeral error and the card stays open; the migration `0001` fails on a database that already has two users with one `slack_id` (the local test database had one test-made case, cleaned).
