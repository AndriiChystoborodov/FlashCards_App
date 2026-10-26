# Using Retain with real students (before the first pilot)

Everything else in `docs/` describes development on `retain_dev`. This file lists what changes when real people receive cards. Nothing here was run with real students yet; the Slack parts are unverified where marked.

## Checklist

1. A separate database `retain_real` (below). Never `retain_dev`.
2. The Slack app installed in the students' workspace (below).
3. Reminders and the 14-day cleanup built first (Task 6b-2, below).
4. A course of about four weeks or more.
5. The laptop running `npm run dev` at `SEND_HOUR` (below).

## 1. A separate database

`npm run scenario` and `npm run db:reset` wipe `retain_dev`; the reset guard in `src/db/reset.ts` (allow-list `retain_dev` and `retain_reset_test`, localhost, no query parameters) must keep refusing anything else, so it is not changed.

```bash
# once: create the database in the same Docker Postgres (init scripts only run on the first volume init)
docker compose exec db psql -U retain -d postgres -c "CREATE DATABASE retain_real"
# apply the committed migrations; drizzle-kit migrate only applies migrations and never drops anything
DATABASE_URL=postgres://retain:retain@localhost:5433/retain_real npm run db:migrate
```

Put the settings for real use in `.env.real` (ignored by git through `.env.*`) and start every command with `DOTENV_CONFIG_PATH=.env.real`, which `dotenv/config` honors. Without the variable `.env` is read (that is `retain_dev`). A wrong or missing file path means no `DATABASE_URL` and the process stops at startup (checked: with a missing file `DATABASE_URL` stays unset).

```bash
DOTENV_CONFIG_PATH=.env.real npm run dev
DOTENV_CONFIG_PATH=.env.real npm run teacher:token -- you@company.com "Your Name"
```

`.env.real` holds the real `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `DATABASE_URL` (`.../retain_real`), `TENANT_TIMEZONE`, `SEND_HOUR`. The MCP client config gets the token printed by `teacher:token` (a separate token from the `retain_dev` one).

**Never run against `retain_real`:** `npm run db:reset` (refuses by design), `npm run scenario`, `npm run demo:seed` (refuses), `drizzle-kit push` or `drop`, `npm test` with a `TEST_DATABASE_URL` that points at it. Before each `db:migrate`, take a dump: `docker compose exec db pg_dump -U retain retain_real > retain_real-$(date +%F).sql` (keep it outside the repo). Docker volumes survive `docker compose down` but not `down -v`.

Local Docker Postgres has the default password `retain` and is bound to `127.0.0.1` only. For real people's data consider a stronger password and backups before more than a pilot; hosting is later ([decision 0023](decisions/0023-local-first.md)).

## 2. Which Slack workspace

- `users.lookupByEmail` finds only users of the workspace where the bot is installed. Install the app (from [slack/manifest.dev.yaml](slack/manifest.dev.yaml)) in the **workspace your students are in**, with new tokens in `.env.real`. A test workspace's bot cannot reach them.
- Students must use in Slack the email you enroll. `slack_matched: false` in `enroll_students` and `list_students` means no match; that student gets nothing.
- Guests: Slack guests are workspace users and should be found; whether the bot can DM them depends on the channels and settings of the workspace (unverified). Slack Connect users from another organization are not workspace users and are not found by `lookupByEmail` (unverified). Test with one guest and one external address before relying on them.
- The bot cannot DM a user in a workspace it is not in; `channel_not_found` is logged and that student is blocked (below).

## 3. The laptop must run

`npm run dev` runs the REST API, Slack in Socket Mode and the tick in one process. Students get their daily cards when the tick runs at or after their local `SEND_HOUR`; if the laptop sleeps through `SEND_HOUR` the cards arrive at the first tick after it wakes, the same day (scheduler.md: "local hour is at least `SEND_HOUR`"). A card answered while the laptop is off cannot be recorded: the click reaches nobody. Keep the machine awake (for example `caffeinate -s npm run ...`). The tokens in `.env.real` stay on the laptop.

## 4. Build 6b-2 before real students

Task 6b-2 (reminders and the 14-day cleanup) is not built ([decision 0027](decisions/0027-task6b1-tick-choices.md)). Without it:

- A student who ignores a card stays blocked on it: one open card per student ([decision 0008](decisions/0008-delivery-next-card-after-answer.md)), no reminder, no release until they answer, are removed or the course ends. `waiting_since` in the progress tools shows it.
- A permanent Slack failure for one student (user unreachable) re-fails on every tick and blocks that student ([decision 0029](decisions/0029-task8-slack-wiring-choices.md) #4); it is only logged.
- The cleanup of removed students after `REMOVED_RETENTION_DAYS` does not run (the enrollment is hard-deleted at re-enrollment time only).

## 5. Other known limits that matter

- **Short courses:** a perfect Medium student learns 4 of 10 cards in 12 days ([decision 0026](decisions/0026-task6-scheduler-choices.md)). Use courses of about four weeks or more, or accept `completed_progress` below 100.
- **Frozen cards:** after `start_course` a typo cannot be fixed ([decision 0016](decisions/0016-flashcards-frozen-after-start.md)); check every card with its correct option before starting.
- **Double cards:** if a Slack post succeeds but recording its timestamp fails, a student can get a card twice ([decision 0027](decisions/0027-task6b1-tick-choices.md)).
- **`scheduled_start_at` starts nothing**; the teacher calls `start_course`.
- **Unverified against real Slack:** wrong answer and "Don't know", double click, the 3-second ack, 429 and outage behaviour, the tick, the stop DM ([slack/live-run.md](slack/live-run.md)). Run those in the pilot with yourself as the student first.
- **No student login:** the student REST routes stay off; students only use Slack.
- **Large results:** `list_students` and the progress tools return the whole class as one JSON text; no pagination ([mcp-teacher-api.md](mcp-teacher-api.md#known-limits)).
- **`SLACK_MODE=http`** is not built; the laptop uses Socket Mode.
- Do not run `npm run scenario` or `npm run db:reset` while you use MCP against `retain_dev`: they wipe the teacher and the token.
