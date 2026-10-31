# Live run (Task 8a): what you do by hand

Everything below needs your real Slack workspace. The first live run was done by the user and reported on 2026-10-26 (results below). Only what that run showed is verified against real Slack; the rest of the adapter (`src/slack/web.ts`), the Bolt wiring (`src/slack/start.ts`) and `src/index.ts` is still tested only with a stub client and `FakeSlack`.

## Live run results (reported by the user, 2026-10-26)

**First run.** The user answered the three assessment cards right + Easy. The student was exempt and got the "already know this material" message. Real Slack delivered the course start DM, the cards, the message replacement and the final DM, all within about a minute.

**Verified live by the first run:**
- `postCard` (course start DM and the cards), `replaceMessage` (the clicked cards were replaced), and the exempt DM reached the user in real Slack.
- The click path from a button to the answer service worked for right + Easy, and an assessment pass with 3 of 3 passed made the student exempt (score 100).
- The whole sequence ran within about a minute. This is not a measurement of the 3-second ack.
- Implied by the run (a DM reached the matched user): `users.lookupByEmail` found the email. Its time zone value was not inspected.

**Second run.** Not reported yet. Nothing from it is recorded here.

**Still unverified against real Slack:**
- Wrong answer and "Don't know" paths, including the material link text.
- A double click and the "This card was already answered." reply.
- The 3-second ack timing on a real connection, and button rendering with 10 options.
- A Slack outage or a 429 (retry 5 times in 5 minutes, timeout 15 s in `src/slack/start.ts`).
- Whether Slack retries a `block_actions` click.
- The tick against real Slack: next-day cards, stale-claim recovery and the stop DM. The exempt student gets no further cards, so the tick sent nothing to test.
- `users.lookupByEmail` time zone, and a student whose email Slack does not know.

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

- Slack DM from the bot: "The course \"<title>\" has started for you. Your first card follows.", then the first assessment card with buttons 1 to 3 and "Don't know". Terminal 1 prints `click user=... action_id=...` for every click (no values, no tokens).
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

## Image card spike

Decision [0033](../decisions/0033-image-cards.md), Stage A. It checks what only a real workspace can answer; it needs no database and changes no production code.

1. Add the bot scope `files:write` (api.slack.com/apps, _OAuth & Permissions_; the manifest [manifest.dev.yaml](manifest.dev.yaml) already lists it) and **reinstall the app**. Slack gives the same `xoxb-` token again or a new one: put the current one in `.env`.
2. **Stop `npm run dev`** (two Socket Mode connections split the clicks).
3. Run `npm run spike:image -- --email <your Slack email>`. It first prints `auth.test` (bot user id, scopes), then tries up to four ways of getting the image into the card (A private upload with retries, B upload shared to your DM, C `slack_file.url`, D explicit upload calls), stops at the first that Slack accepts and uses it for all four cards. B puts a separate file message and the intro text message into your DM: that is expected. If nothing works the script says so after about 70 seconds. Optional: `--email2 <another user>` posts the same file id to them; `--share` shares the upload to your DM channel instead of leaving it private (try it only if the private image does not show).
4. Expect 4 DMs (short, long, Russian, German): an image with the question, the options as text, and the buttons 1, 2, 3, Don't know. Click one answer on each card. The script logs which replacement it used (card 1 and 2: text only, card 3: text plus the same image, card 4: `chat.update` text only).
5. Tell Claude (paste the whole output): which strategy printed `ACCEPTED` and after how many seconds, whether `files.info` failed with `missing_scope`, whether a separate file message appeared, do the images show; did the image disappear or stay after each click (expected: gone on cards 1, 2 and 4, kept on card 3); the printed timings; the log lines; whether user 2 sees the image (or `reuse across users: unverified`).

## Image cards live check (Task 8b, built)

What the image spike showed (2026-10-27, [decision 0034](../decisions/0034-image-cards-stage-b.md)): a private upload plus a post works after one retry at 0.5 s; replacing through `response_url` with the same image block keeps the image, with text only removes it; about 2 s per card. Not yet seen live in the real flow (what the spike did not run): the cards sent by the scheduler, the rating prompt and outcome with the image kept, the fallback.

Hand-steps (the app needs `files:write`, the app was reinstalled for the spike):
1. `npm run db:up`, `npm run db:reset`, `npm run dev` (terminal 1).
2. `npm run demo:seed -- you@company.com 3` (terminal 2). The demo course now has one Russian card (the last assessment-free card) besides the English ones.
3. Look at the first card in Slack: an image with the question, the options as text under it, the buttons 1, 2, 3 and Don't know. Note how long the first card takes after the seed (about 2 s expected).
4. Click a RIGHT option: the image must stay with the Hard / Medium / Easy buttons under it. Click a rating: the image stays with "Thanks. You rated it ...". Click a WRONG option on a later card: the image stays with the right answer.
5. Fallback: temporarily remove `files:write` from the app (or run with a revoked token for files only), reinstall, restart `npm run dev` and trigger a card: a plain text card arrives and the log shows `image unavailable (upload_failed)`. Restore the scope afterwards.
6. Tell Claude: did every card show its image, the time per card, whether the image stayed in all three replacements, and what the log printed for any `image unavailable` or `image dropped on replace` line.

