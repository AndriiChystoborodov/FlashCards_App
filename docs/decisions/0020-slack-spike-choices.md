# 0020. Slack spike (Roadmap Task 2): choices the docs left open

## Context

AGENTS.md Task 2 and [slack/integration.md](../slack/integration.md) fix the buttons, values and flow but leave file layout, card content, wording and logging open. All answers below were given by the user on 2026-10-25 (source: the user, relayed in the Task 2 session).

## Choice

- Correct answer: a server-side constant (`SPIKE_CARD.correctOption`) in `src/slack/card.ts`, looked up by card id. Never in a button value.
- Test card: id `spike-1`, "What is the maximum fine under the policy?", options 100 / 500 / 1000, right option is 2 (500).
- Wrong answer or Don't know shows only the right answer, no `material_url`.
- Texts: "Right. How hard was it?"; buttons "Hard", "Medium", "Easy"; "Thanks. You rated it {Hard|Medium|Easy}."; "Not quite. The right answer is {n}: {option text}."; "This card was already answered."
- Files: `src/slack/card.ts` (card data and blocks), `handlers.ts` (zod value schemas, `parseValue`, handlers), `app.ts` (Bolt App in Socket Mode, startup DM), `spike.ts` (entry for `npm run spike`). `src/index.ts` stays the config check. Tests sit next to the code (`src/slack/*.test.ts`).
- Click logs use `console.log`, malformed values `console.warn`. Every incoming action is logged with an ISO timestamp, `action_id` and value.
- The spike skips test cases H4, H9 and the `message_ts` checks (Task 8, need the database). The rating handler logs and replaces the message; the calculator is not called.
- "Already answered" is detected by an in-memory set of user + card (lost on restart). This is the implementer's reading of how to use that text without a database, not an explicit user choice; replace it in Task 5/8.
