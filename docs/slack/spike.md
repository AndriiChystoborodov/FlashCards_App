# Slack spike (Roadmap Task 2)

Choices: [decision 0020](../decisions/0020-slack-spike-choices.md). Code: `src/slack/`. Build status: implemented and unit-tested with fakes on 2026-10-25. Live run done by the user on 2026-10-25 (results below).

## Live run result (reported by the user, 2026-10-25)

- The card arrives by DM using only the `chat:write` scope (no `conversations.open`, no `im:write`).
- Right answer, then the Hard / Medium / Easy rating, works.
- Wrong answer 1 and "Don't know" both work.
- No duplicate `block_actions` deliveries seen across 5 runs.
- Not tested: a double-click on the same button.

## Run steps

1. `.env` has `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_TEST_USER_ID`.
2. `npm run spike`. The terminal prints `Spike running: test card sent.` and the bot DMs the card.
3. Click 2 (right). Message becomes "Right. How hard was it?" with Hard / Medium / Easy. Click one: message becomes "Thanks. You rated it …." and the terminal prints a `rating user=… card=spike-1 option=1 rating=…` line.
4. Run again, click 1, 3 or Don't know: message becomes "Not quite. The right answer is 2: 500."

Every click prints `[ISO time] click user=… action_id=… value=…`.

## What the spike observes about retries

The log line above is printed on every delivery, so a retried delivery would appear as a second line with the same action_id and value. Result of the live run: no duplicate deliveries across 5 runs. This is an observation in Socket Mode with fast handlers, not a guarantee; a slow or failing handler was not tested. The double-click case was not tested.

## Not covered

H4 (card owner), H9 (9 options), `message_ts` checks, the calculator call: Task 5/8. "Already answered" uses an in-memory set of user + card (implementer's reading, see decision 0020); a right answer is not added to it until the rating click.
