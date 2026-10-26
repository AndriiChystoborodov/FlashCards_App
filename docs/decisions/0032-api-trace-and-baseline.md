# 0032. An API trace of the scenario, a viewer, and a committed baseline

Source: the user, 2026-10-26 (Part 1 of the plan, approved; Part 2, a live stream, is not built). Context: a later cloud-first refactoring (database connection, Slack in HTTP mode, the tick as a worker, remote MCP) needs a baseline of what talks to what today. Follows [0023](0023-local-first.md), [0030](0030-scenario-report.md), [0028](0028-task7-rest-api-choices.md).

## Choice

1. While `npm run scenario` runs, a recorder (`src/trace/recorder.ts`) records every REST call, every `SlackPort` call, every Bolt action-handler run and the in-process entries into the services (the tick, a student answer), and per step the row-count change of every table. The scenario's steps and assertions are unchanged (`23 ok, 1 pending`, with the recorder off and on; `npm run scenario:parity` checks the lines and the table deltas).
2. Nothing is global and nothing runs in production: the recorder is an optional `ApiDeps.recorder`, a decorator around the `SlackPort`, a decorator around the `ActionRouter`, and `within()` around the entry points. `src/index.ts` does not create one.
3. **REST is recorded on the server side** by middleware that `createApp` mounts only when `deps.recorder` is set. It reads Express's route path (`req.route.path`), so the template is exact. The caller comes from a recorder-only header `x-trace-caller` that the scenario's two clients set (`mcp:<tool>` for the MCP tools, `scenario-rest` for raw calls). The header is validated (`[A-Za-z0-9:_.-]{1,60}`), never read without a recorder, never used for authorization, and a test shows the same status, body shape and database effect with and without it. A call without a valid tag is `unattributed`.
4. **Slack calls are attributed with an `AsyncLocalStorage` owned by the recorder instance**: the REST middleware, the router decorator and `within()` set the entry point, so a `postCard` made by `start_course` is shown as caused by `mcp:start_course`. Outside any entry point it is `unattributed`.
5. **Handlers and the tick call the services directly, not REST.** The trace shows this and the viewer says so next to the swimlanes and in the boundary legend. For the cloud refactoring it is a decision to make: a separate handler or tick process either shares the services library and the database (only B1), or calls REST, which has no worker authentication today (teacher tokens only; student routes are development-only, [0018](0018-student-routes-dev-only.md)).
6. **Redaction** (`src/trace/redact.ts`) happens when an event is recorded, so raw values are never kept. Four layers: key names (`authorization`, anything with `token`, `secret`, `password`, `cookie`, `apikey`, `credential`; `email`, `name`, `full_name`, `slack_id` become aliases); patterns on every string and object key (Bearer values, `xox*-`/`xapp-` tokens, database URLs with credentials, emails also as `%40` and `@`, uuids, Slack ids, bare 20+ character tokens that mix letters and digits); live secrets registered by the scenario (the Slack tokens and the database URL from the environment, Tom's token, the bad token), replaced in any case and URL-encoded; and a fail-closed scan (`assertClean`) over the serialized text. Placeholders are first-seen aliases: `teacher-1`, `student-1`, `U-1`, `D-U-1`, `course-1`, `card-3`, `user-id-2`, `name-1`.
7. Files: `reports/trace.json` (full redacted bodies, git-ignored), `reports/trace.html` (`npm run trace:report`, scanned the same way, nothing written on a hit) and the committed baseline `docs/baseline/trace.json`. The scenario also searches every file under `reports/` for every registered secret, fake email and fake Slack id and fails if one is found.
8. **The baseline stores REST bodies as shapes** (keys and types) and everything else as recorded (statuses, templates, callers, Slack texts, click outcomes, table deltas), one event per line. `npm run scenario:compare` diffs a run against it: added, removed and changed calls (status, body shape), changed table deltas, added or removed steps. Exit 0 no difference, 1 differences, 2 a file is missing or unusable. `-- --accept` replaces the baseline deliberately (refused when the text still looks sensitive); the change is then reviewed in `git diff` and committed.
9. The viewer (`src/trace/render.ts`) is one file of inline HTML and SVG, no script, no external request, `<details>` for the bodies, 17 px and larger text, black on white, marks that differ by shape and letter. It has the per-step swimlanes, an endpoint catalog matched by method plus path template against `docs/rest-api.md` (18 routes: 16 teacher, 2 student; the two student routes are shown as "disabled in the scenario by design", not as a gap), and the four boundaries.

## Boundary marks

| mark | shape | arrow | what changes in the current code |
| --- | --- | --- | --- |
| B1 | square | Services to Postgres, once per step that changed rows | every process builds its own pool with `createDb(DATABASE_URL)`; hosted TLS URL, migrations job, a pool per process |
| B2 | triangle | Slack to the action handlers | `src/index.ts` refuses `SLACK_MODE=http`; needs the signing secret and a public route; the 3-second ack on a request |
| B3 | diamond | tick to the services | `startTick` runs in the web process; a worker needs its own entry point, pool and Slack port; the database claim is the overlap guard |
| B4 | hexagon | MCP client to the REST API | `src/mcp/index.ts` is stdio with one token from the environment; remote needs an HTTP transport and a token per teacher |

Services to Slack adapter is already a network call (Slack Web API) and carries no mark.

## What ran for real and what is only recorded

Real: the REST app (Express, zod, services) over real HTTP on `127.0.0.1`, the services and every query against local Postgres `retain_dev`, the MCP tool module and REST client, the Bolt handler functions (called with a fake router). Faked: Slack (`FakeSlack`; the trace's Slack calls are the calls into that fake). Recorded by wrappers, not observed on the wire: Slack port calls, handler runs and outcomes, entry points. Read from Postgres: table counts before and after each step (not queries). Inferred: the Services lane (entry points and the REST-to-services hop), the lane arrows (fixed by event kind), and handler outcomes (derived from the text the handler answered with; a click that ends without a message, duplicate or malformed, shows `no_response`).

## Choices I made

| # | choice | why |
| --- | --- | --- |
| 1 | The REST middleware records on `res.finish`, wrapping `res.end` to read the body | no change to the routes; all responses here go through `res.json` |
| 2 | Event order is reserved when a call starts (a request is listed before the Slack calls it causes) | the swimlane reads in causal order |
| 3 | Time stamps are the controlled clock, durations are not recorded | determinism of the baseline |
| 4 | No `--strict` compare of body values; `reports/trace.json` keeps the values for a manual diff | the baseline stays small and stable, shapes catch contract changes |
| 5 | Compare exit code 2 for an unusable file | 1 means differences, as asked |
| 6 | The baseline keeps Slack message texts | they are what students see, and a change should show |
| 7 | Bearer pattern needs 8 or more characters after the word | the API's own message "invalid bearer token." must not be rewritten; real values are caught by the registered secrets and the bare-token rule |
| 8 | `trace:report` scans the page after decoding entities and dropping our own doc links | the scan sees what a reader sees |
| 9 | Table counts are read for every table before and after each step; step 1 starts from zero | the reset step drops the tables, so its delta must not depend on the old database |
| 10 | `SCENARIO_TRACE=off` runs the scenario without any recorder and writes only the step deltas | the parity check |

## What is normalized in the baseline, and the order it still guarantees

`seq` is a real counter in `reports/trace.json` (`recorder.ts` takes the next number when a call starts). `toBaseline` in `src/trace/compare.ts` sets it to 0 on purpose: an inserted or removed call would otherwise renumber every later event and every line would differ. The baseline keeps the order as the **array order within a step**, which is the order the calls started (reserved when they begin, so a request is listed before the Slack calls it causes). Compare pairs events by array order (longest common subsequence of their signatures) and ignores `seq`; the viewer also draws in array order. The same normalization turns REST bodies into shapes and leaves `t` (the controlled clock) as recorded.

## Rule: synthetic data only

The trace and the baseline are built only from the scenario's synthetic data. `reports/` stays git-ignored, `docs/baseline/trace.json` is committed only after the scan passes, and real student data must never be traced. The future live stream (Part 2) follows the same rule: dev-only, loopback, no payload bodies, the same redactor.

## Redaction limits

Redaction is pattern based, so it does not catch: an unregistered secret under an ordinary key name; a letters-only token shorter than 32 characters (longer ones and mixed letter-digit tokens from 20 are caught); look-alike (homoglyph) characters; emails written like `bob (at) corp.example`; names inside free text. It over-redacts long slugs (20 or more characters with a letter and a digit, for example `security-basics-2026-intro-module1`) to `[token]`, which only adds noise to a diff. The docker database password `retain` is too short and common to register on its own (it would rewrite the word everywhere), so it is covered only as part of the registered database URL.

## Not covered

The live stream (Part 2) is not built.
