# Slack spike (Roadmap Task 2)

Choices: [decision 0020](../decisions/0020-slack-spike-choices.md). Code: `src/slack/`. Build status: implemented and unit-tested with fakes on 2026-10-25. The live run against Slack is **not yet done** (manual step for the user; record its result here).

## Run (expected behaviour; not yet seen live)

1. `.env` has `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_TEST_USER_ID`.
2. `npm run spike`. The terminal prints `Spike running: test card sent.` and the bot DMs the card.
3. Click 2 (right). Message becomes "Right. How hard was it?" with Hard / Medium / Easy. Click one: message becomes "Thanks. You rated it …." and the terminal prints a `rating user=… card=spike-1 option=1 rating=…` line.
4. Run again, click 1, 3 or Don't know: message becomes "Not quite. The right answer is 2: 500."

Every click prints `[ISO time] click user=… action_id=… value=…`.

## What the spike observes about retries

Whether `block_actions` is retried is unverified in the docs. The log line above is printed on every delivery, so a retried delivery would appear as a second line with the same action_id and value. Result of the live run: not observed yet.

## Not covered

H4 (card owner), H9 (9 options), `message_ts` checks, the calculator call: Task 5/8. "Already answered" uses an in-memory set of user + card (implementer's reading, see decision 0020); a right answer is not added to it until the rating click.
