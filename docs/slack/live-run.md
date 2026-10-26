# Live run (Task 8a): what you do by hand

Everything below needs your real Slack workspace. Until you have done it, **nothing of Task 8a has run against the real Slack API**: the adapter (`src/slack/web.ts`), the Bolt wiring (`src/slack/start.ts`) and `src/index.ts` are tested only with a stub client and `FakeSlack`.

## Before the first run

1. The manifest ([manifest.dev.yaml](manifest.dev.yaml)) needs no change for 8a: `chat:write`, `users:read`, `users:read.email`, interactivity and Socket Mode are already there. If your app was created from it, nothing to reinstall.
2. `.env` has `SLACK_BOT_TOKEN` (`xoxb-`), `SLACK_APP_TOKEN` (`xapp-`, `connections:write`), `DATABASE_URL` (`retain_dev`), `TENANT_TIMEZONE`. `SLACK_TEST_USER_ID` is not needed. To see ticks quickly add `SEND_HOUR=0` and `TICK_MINUTES=1`.
3. Use the email address of **your own Slack account** (profile → email). `users.lookupByEmail` finds nobody else.

## Commands, in this order

```bash
npm run db:up
npm run db:reset              # wipes retain_dev
npm run dev                   # terminal 1: REST, Slack (socket mode) and the tick; leave it running
npm run demo:seed -- you@company.com 3    # terminal 2: demo course, enrolls you, starts it
```

`demo:seed` refuses unless `DATABASE_URL` is exactly `retain_dev` on localhost with no query parameters. It prints a teacher token once (a new run replaces it); do not paste it anywhere.

## What to expect

- Slack DM from the bot: "A new course has started for you. Your first card follows.", then the first assessment card with buttons 1 to 3 and "Don't know". Terminal 1 prints `click user=... action_id=...` for every click (no values, no tokens).
- Right answer: "Right. How hard was it?" with Hard / Medium / Easy; after the rating "Thanks. You rated it ...", then the next card as a new message.
- Wrong answer or "Don't know": "Not quite. The right answer is N: ..." with the material link, then the next card.
- The second click on an answered card: "This card was already answered."
- The three assessment cards come first. Then new cards follow: one a day for a 3-day course. With `SEND_HOUR=0` and `TICK_MINUTES=1`, terminal 1 prints `tick <time>: sent=... resent=... failed=...` every minute; `sent=1` means the tick started your next day.
- If Slack does not know the email, `demo:seed` says so (`slack_matched` false): you are enrolled but get no card; run it again with the right address.
- Running `demo:seed` again for the same course only enrolls (the course is reused); a finished course needs a reset.

## Not covered by the tests: look for these

The 3-second ack on a real connection, button rendering with 10 options, a double click, the reaction to a Slack outage or a 429 (disconnect your network during a click), `chat.update` removing the buttons, `users.lookupByEmail` and its time zone, the retry and timeout settings of `src/slack/start.ts`. Tell me what you see and I record it in `docs/slack/spike.md`-style notes.

## Reset and stopping

**Stop `npm run dev` (Ctrl+C) before `npm run scenario` or `npm run db:reset`: both wipe `retain_dev` while the server holds connections and a tick may be mid-pass.** To start over: stop `npm run dev`, `npm run db:reset`, `npm run dev`, `npm run demo:seed -- ...`. Old messages in Slack stay; a click on one says "This card was already answered."

`SLACK_MODE=http` is not built: `npm run dev` stops at startup with that message.
