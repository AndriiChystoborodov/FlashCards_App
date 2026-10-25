# 0019. Env schema and tooling for Task 1

## Context

AGENTS.md (Task 1) and [implementation-plan.md](../implementation-plan.md) list the env variables and tools but leave formats, defaults and tooling details open. All answers below were given by the user on 2026-10-25.

## Choice

Env (`src/config/env.ts`, zod 4, loaded through `dotenv`, exports `parseEnv()` and the parsed `env`):

| variable | rule | default |
| --- | --- | --- |
| `NODE_ENV` | `development`, `test`, `production` | `development` |
| `SLACK_MODE` | `socket`, `http` | `socket` |
| `SLACK_BOT_TOKEN` | required, starts with `xoxb-` | |
| `SLACK_APP_TOKEN` | required, starts with `xapp-` | |
| `SLACK_SIGNING_SECRET` | required only when `SLACK_MODE=http` | |
| `SLACK_TEST_USER_ID` | required only when `SLACK_MODE=socket` | |
| `TENANT_TIMEZONE` | valid IANA name | `UTC` (`.env.example`: `Europe/Zurich`) |
| `SEND_HOUR` | integer 0 to 23 | 9 |
| `REMOVED_RETENTION_DAYS` | positive integer | 14 |
| `STUDENT_ROUTES_ENABLED` | `true` or `false`; `true` with `NODE_ENV=production` fails startup ([0018](0018-student-routes-dev-only.md)) | `false` |
| `DATABASE_URL` | optional until Task 4 | |

- Error messages name the variable and the rule, never the value.
- An empty value (as in `.env.example`) counts as unset.
- `TICK_MINUTES`, `REMINDER_AFTER_HOURS`, `MAX_REMINDERS` are added in Task 6.
- Dependencies are pinned to exact versions. `engines.node` is `>=20`, `private: true`.
- `tsconfig.json`: strict, `nodenext`, target ES2022, `skipLibCheck`, include `src`, no `outDir`. `types: ["node"]` is required because TypeScript 7 no longer loads `@types` implicitly.
- `dev` is `tsx watch src/index.ts`; `src/index.ts` only validates the env for now.
- `vitest.config.ts` limits discovery to `src/**/*.test.ts`, because the default also picks up test files inside the agent skill folders (`.agents`, `.claude`, `.codex`) and fails.

## Why

Chosen by the user so that Task 1 needs no further decisions.
