# Slack integration

Setup of the app (manifest, tokens) is in [README.md](README.md). Setup status: app created and tokens in `.env` (reported by the user, 2026-10-24). This page covers how the code uses Slack. Facts come from docs.slack.dev and `@slack/bolt` 5.1.0.

## Running Bolt with Express ([decision 0002](../decisions/0002-slack-socket-mode-dev-http-prod.md))

- Dev: our own `express()` app serves REST. A separate `new App({ token, appToken, socketMode: true })` runs in the same process. Two listeners, shared services.
- Prod: `new ExpressReceiver({ signingSecret, app: ourExpressApp })`, `new App({ token, receiver })`. One port, route `POST /slack/events`.
- One env flag (`SLACK_MODE=socket|http`) selects the mode. `ExpressReceiver` is HTTP-only; `SocketModeReceiver` takes no Express app.

## Card message

Question and numbered options live in the message `text`. Buttons carry only numbers.

```json
{ "text": "Q: What is the maximum fine under the policy?\n1. 100\n2. 500\n3. 1000",
  "blocks": [
    { "type": "section", "text": { "type": "mrkdwn", "text": "*What is the maximum fine under the policy?*\n1. 100\n2. 500\n3. 1000" } },
    { "type": "actions", "elements": [
      { "type": "button", "action_id": "answer_1", "text": { "type": "plain_text", "text": "1" }, "value": "{\"c\":\"<flashcardId>\",\"o\":0}" },
      { "type": "button", "action_id": "answer_2", "text": { "type": "plain_text", "text": "2" }, "value": "{\"c\":\"<flashcardId>\",\"o\":1}" },
      { "type": "button", "action_id": "answer_3", "text": { "type": "plain_text", "text": "3" }, "value": "{\"c\":\"<flashcardId>\",\"o\":2}" },
      { "type": "button", "action_id": "answer_dont_know", "text": { "type": "plain_text", "text": "Don't know" }, "value": "{\"c\":\"<flashcardId>\",\"o\":null}" }
    ] } ] }
```

Limits: button `text` 75 chars, `value` 2,000, `action_id` 255; message `text` under 4,000 chars (anything past 40,000 is cut). Always set top-level `text` as well as `blocks`. The 50-blocks-per-message limit is unverified; a card uses 2.

Rating step after a right answer: same message replaced with buttons `rate_hard`, `rate_medium`, `rate_easy`, value `{"c":…,"o":1,"r":"easy"}`. Nothing is stored between the two clicks.

The value never contains the correct answer. The server looks it up.

## Handler

```ts
const answerValue = z.object({ c: z.string(), o: z.number().int().min(0).nullable() });
const rateValue = z.object({ c: z.string(), o: z.number().int().min(0), r: z.enum(['hard', 'medium', 'easy']) });

// Button values come from the client: never throw, log and ignore anything malformed.
function parseValue<T>(schema: z.ZodType<T>, raw: unknown): T | null {
  if (typeof raw !== 'string') return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

app.action(/^answer_/, async ({ ack, action, body, respond, logger }) => {
  await ack();                                   // first, within 3 seconds
  const v = parseValue(answerValue, 'value' in action ? action.value : undefined);
  if (!v) return logger.warn({ user: body.user.id, action: action.action_id }, 'ignored malformed answer value');
  await answerService.onAnswer({ slackUserId: body.user.id, ...v, respond });
});

app.action(/^rate_/, async ({ ack, action, body, respond, logger }) => {
  await ack();
  const v = parseValue(rateValue, 'value' in action ? action.value : undefined);
  if (!v) return logger.warn({ user: body.user.id, action: action.action_id }, 'ignored malformed rating value');
  await answerService.onRating({ slackUserId: body.user.id, ...v, respond });
});
```

`answerService.onAnswer` handles the first click: wrong or "Don't know" calls the calculator at once; a right answer only shows the Hard / Medium / Easy buttons and stores nothing. `onRating` is the second click: it recomputes `isCorrect` on the server from `o` (the value never carries the answer), then calls the calculator with the rating. A rating for an answer that is not correct is ignored by the calculator ([decision 0004](../decisions/0004-right-answer-requires-rating.md)). A failed parse does nothing and shows nothing to the student; the message stays as it is.

The service checks the clicker owns the card, `sent_at` is set, and the message `ts` matches `message_ts`. After a reminder the card has a new `message_ts`; a click on the older message gets "sent again, use the latest message" ([scheduler.md](../scheduler.md#unanswered-cards)). After the outcome it calls `respond({ replace_original: true, ... })` (5 uses within 30 minutes). Two fast clicks can still arrive together, so the reviews unique key is the real lock.

Refusals from `submitAnswer` (`src/services/answer.ts`), one code per text:

| code | text |
| --- | --- |
| `sent_again` | "This card was sent again, use the latest message" |
| `removed` | "You are no longer enrolled in this course" |
| `course_over` | "The course is over." (with the full stop, as `TEXT.expired`) |
| `not_open` | "This card was already answered." (chosen in Task 8, the spike's text) |
| `not_enrolled` | "You are not enrolled in this course." (chosen in Task 8; also a Slack user we do not know) |
| `duplicate` | no text: nothing is sent, the click that won already replaced the message |
| unexpected error | ephemeral "Something went wrong. Please try again." (buttons stay) |

Outcome messages:
- Right: "Right. How hard was it?" with Hard / Medium / Easy.
- Wrong or Don't know: the right answer and `material_url`.
- After the rating: confirmation, then the next card as a new message.

## Identity

- On `POST /courses/:id/students`: `users.lookupByEmail` (needs `users:read.email`, Tier 3, about 50 per minute) fills `slack_id`; space calls out or rely on the client's 429 retry. `users_not_found` leaves `slack_id` null and the API reports `slack_matched: false`.
- `chat.postMessage({ channel: slackUserId })` opens the DM with only `chat:write` (verified by the live spike, 2026-10-25). No `conversations.open` and no `im:write`. Cache the returned `D…` channel in `users.slack_dm_channel`.
- `channel_not_found` means the app cannot DM that user; log it for now. Showing unreachable students to the teacher is an idea for later ([implementation-plan.md](../implementation-plan.md#risks-and-ideas)).
- Timezone: `users.info` gives `tz`; needs `users:read`, already in the manifest.

## Course notifications

`POST /courses/:id/start` sends a DM to every present `active` student with a `slack_id`, then the first assessment card. `POST /courses/:id/stop` sends the "course has ended" DM to every `active` enrollment it completes; `exempt` and removed students get nothing ([decision 0028](../decisions/0028-task7-rest-api-choices.md)). Sent sequentially.

## Retries and rate limits

- Events API retries 3 times (immediately, 1 minute, 5 minutes). Button clicks (`block_actions`) are not retried the way events are (no duplicates seen in 5 live spike runs; see [spike.md](spike.md). Double-click not tested). Ack first; on a processing failure, tell the student with `respond`.
- `chat.postMessage` is about 1 message per second per channel with bursts; `chat.update` and `users.lookupByEmail` are Tier 3.
- The Bolt `WebClient` retries HTTP 429 using `Retry-After` (unverified default). No extra limiter for the MVP.

## Built in Task 8 ([decision 0029](../decisions/0029-task8-slack-wiring-choices.md))

- `src/slack/web.ts`: `slackPort(web)` implements the port with `chat.postMessage`, `chat.update` and `users.lookupByEmail` (its response already holds `user.tz`, so there is no `users.info` call). A failure becomes `SlackPortError(method, code)` carrying only Slack's error code; `users_not_found` is `null`. A rejected post means nothing was sent: the scheduler keeps the claim and the tick re-posts it after 10 to 25 minutes (decision 0027); `sendFirstCards`, `enrollStudents` and the tick catch and log it.
- `src/slack/start.ts`: the Bolt app in socket mode with `retryConfig: fiveRetriesInFiveMinutes` and `timeout: 15000` (the client default is ten retries over about 30 minutes and no timeout).
- `src/slack/handlers.ts`: `registerHandlers(app, deps)`. `ack()` first. The clicking Slack user is mapped with `findUserBySlackId` (unknown: `not_enrolled`); `previewAnswer` (first click) and `submitAnswer` refuse unless that user is enrolled and the card is open for them, and the click's `message.ts` is the stored one. A right first click stores nothing. Only ids and codes are logged: never a value, a payload or a token.
- `src/index.ts` starts `startServer` (host `HOST`, port `PORT`), then Bolt, then `startTick`. `SLACK_MODE=http` stops at startup with "not built yet". The spike keeps its own handlers (`spikeHandlers.ts`, `npm run spike`).
- Live run: [live-run.md](live-run.md).

## Image cards (planned, Stage A built)

Decision [0033](../decisions/0033-image-cards.md). A card is sent as a generated image of the question; the options stay numbered text under it and the buttons do not change. **Only Stage A exists** (renderer, vendored font, samples, spike script). The REST 500-character limit, the port change (`postCard` taking the image), the scheduler and the trace changes are Stage B and wait for the user's go-ahead after the spike.

- Renderer: `src/render/` (`renderCard(question)` gives `{png, width, height, text, fontSize, lines}` or `{ok: false, code}`; codes `question_too_long`, `unsupported_character`, `empty_question`). 1200x630, Inter, 28 to 64 px, 500 characters.
- Planned message: blocks `image` (`slack_file: {id}`, `alt_text` = the sanitized question), `section` (options), `actions` (unchanged); top-level `text` = question and options. The image is uploaded with `filesUploadV2` (no `channel_id`, so private) before the post; scope `files:write`, reinstall the app after adding it.
- A failed upload throws before anything is posted, so the claim stays and the stale-claim recovery re-posts (decision 0027). A render error on an old card falls back to the text card (Stage B choice) so a claim never loops.
- Documented by Slack and the installed types: `filesUploadV2` = `files.getUploadURLExternal`, POST, `files.completeUploadExternal`; the id is at `res.files[0].files[0].id`; without `channel_id` the file is private; `ImageBlock` takes `slack_file {id | url}` or `image_url`, `alt_text` up to 2,000 characters, PNG, JPG, GIF; "the user posting the blocks must have access to the file"; `chat.update` with blocks replaces them, with text only it removes them.
- First live spike run (2026-10-27): the upload worked but `chat.postMessage` answered `invalid_blocks` ("invalid slack file"). Ranked hypotheses (file not ready yet, private file not resolvable in the DM, not recognised as an image, `id` vs `url`, scope) and the diagnosis ladder are in [decision 0033](../decisions/0033-image-cards.md#spike-run-1-the-user-2026-10-27-the-post-was-rejected). Until the ladder finds a working way, Stage B is blocked.
- Not documented, settled by `npm run spike:image` (user-run, see [live-run.md](live-run.md#image-card-spike)): whether a private file renders in a bot DM to another user, whether `files:read` is needed, what `replace_original` does with an image block, whether one file id renders for a second user, upload latency.

## Testing without Slack

Keep Slack calls behind a small interface (`postCard`, `replaceMessage`, `lookupEmail`). Services get a fake in tests. The Roadmap Task 2 spike proves the real path.
