# 0031. MCP server for teachers (Roadmap Task 9): choices

Source: the user approved the Task 9 plan on 2026-10-26 with these additions: `remove_student` (16 tools), no assumed node path in the docs, `list_flashcards` before `start_course`, a stdout-cleanliness test, an independent leak review. Follows [mcp-teacher-api.md](../mcp-teacher-api.md), [0007](0007-mcp-stdio-thin-client.md), [0014](0014-teacher-token-hashed.md), [0016](0016-flashcards-frozen-after-start.md). (0030 is the scenario report.)

## Answers

1. **`remove_student` is a tool.** The tool table had 15 tools for 16 teacher routes while saying only the student routes were not exposed; the scenario's removal step needs it. It follows the rule of the other destructive tools (`confirmed: true`).

## Choices

| # | choice | why |
| --- | --- | --- |
| 1 | Files: `src/mcp/client.ts` (REST client, config check), `tools.ts` (16 definitions, `registerTools`), `index.ts` (stdio entry); tests `tools.test.ts`, `client.test.ts`, `smoke.test.ts` | decision 0007: tools transport-independent, entry file knows the transport |
| 2 | Dependencies pinned: `@modelcontextprotocol/server` 2.4.0, devDependency `@modelcontextprotocol/client` 2.4.0 (the test client; the docs only named the server) | the in-memory pair and the stdio test need a client |
| 3 | The entry file reads `process.env` itself and does not import `src/config/env.ts` | that module requires Slack tokens and a database URL, and dotenv may print to stdout |
| 4 | Run command: `node --import <repo>/node_modules/tsx/dist/loader.mjs src/mcp/index.ts` with an absolute node path; no build step and no npm script | the project has no build; a build can go stale; `npm run` prints a banner on stdout; the `tsx` binary needs `node` on `PATH`, which Claude Desktop does not give (checked with an empty environment) |
| 5 | Own zod schemas per tool (strict objects, so an unknown key is refused), not an import of `src/api/schemas.ts` | the model needs field descriptions; MCP stays free of server code; the API stays the authority. Cost: limits are written twice (known limit in the MCP doc) |
| 6 | `confirmed: z.literal(true)` on `start_course`, `stop_course`, `delete_course`, `remove_student`, never forwarded; `start_course` also orders `list_flashcards` and showing ALL cards with correct options first | the user's rule; a schema `const` cannot be satisfied by omission, `"true"` or `1` |
| 7 | Annotations: reads `readOnlyHint`; stop/delete/remove/start `destructiveHint`; updates `idempotentHint` | lets a client ask for approval; hints only |
| 8 | Results: the REST JSON as one text block, `{"ok":true}` for 204; errors `isError` with `<code>: <message>`; no `outputSchema` | simplest for a model |
| 9 | Error hygiene: a fetch failure is reported as `unreachable` or `timeout` with the origin only (the fetch error text can hold the URL); any other exception is `internal_error` without text; an API message is cut to 500 characters with the token replaced; `redirect: 'manual'` (a 3xx is the error `redirect`) | a redirect would send the bearer token to another host; nothing built from an exception can leak a URL or header |
| 10 | Config check: both variables required and trimmed; URL must be http(s) without user or password; token without whitespace; messages name the variable and never print a value; stdout stays empty and the process exits 1 | the user's rule |
| 11 | Timeout 15 s per request (`AbortSignal.timeout`); no retries | a teacher waits; the API is local |
| 12 | Logging: one `ready` line on stderr (the origin only); nothing else | stdout is the protocol; Claude Desktop writes stderr to `mcp-server-retain.log` |
| 13 | IDs are `z.guid()` (as the REST `idParam`) and are `encodeURIComponent`ed into the path | no path injection (`../x` is refused before the call) |
| 14 | No pagination | the REST API has none (decision 0028 "Not done"); large class JSON is a known limit |
| 15 | The second database for real students is created and migrated with existing commands (`psql CREATE DATABASE`, `DATABASE_URL=... npm run db:migrate`), no new script; `src/db/reset.ts` is unchanged | `drizzle-kit migrate` only applies migrations and never drops; see [real-use.md](../real-use.md) |

## Review round (independent subagent, before the commit)

Focus: token leaks, stdout, the `confirmed` flag, path and URL injection. No leak and no bypass found (checked over real JSON-RPC: omitted, `"true"`, `[true]`, 1, extra key, `__proto__`, missing arguments; `confirmed` is never forwarded; SDK validation errors print paths and messages, not values). Fixed with regression tests:

| finding | fix |
| --- | --- |
| a redirect and a token the fetch layer rejects were both reported as `unreachable` | `redirect: 'manual'`; a 3xx answer is the error `redirect` naming `RETAIN_API_URL` |
| a token with NUL or other control characters passed the startup check and then failed every call | the check rejects whitespace and control characters |
| the response body had no size cap | bodies over 5 MB are `bad_response` (checked after reading; recorded as a shortcut in the code) |

Accepted: `readConfig` drops a query string or fragment of `RETAIN_API_URL`. Not checked by the reviewer: unhandled-rejection output of `serveStdio` on stdin close.

## Not done

- Remote MCP over Streamable HTTP and OAuth (decision 0007, 0023).
- Pagination, rate limits.
- Registration was verified against the documentation only; no real Claude Desktop or Claude Code session was run.
