# 0034. Image cards, Stage B: the sending path, the question limit and the known limits

Source: the user ran the spike in real Slack on 2026-10-27 and approved Stage B ("plan and implementation in one go"). Follows [0033](0033-image-cards.md) (renderer, font, 500-character limit, Stage A), [0027](0027-task6b1-tick-choices.md) (a failed post keeps the claim), [0029](0029-task8-slack-wiring-choices.md) (#13: the options stay text, 2,900 cap).

## Verified by the user in real Slack (the spike)

- A private upload (`filesUploadV2` without `channel_id`) followed by `chat.postMessage` with the image block works (strategy A). Every card (4 of 4) needed exactly one retry: the first post answered `invalid_blocks` and the post 0.5 s later was accepted.
- Empty `mimetype`/`filetype` and no thumbnails right after the upload mean "not processed yet", not a wrong file type.
- Timings (4 samples): render 37 to 168 ms, upload 840 to 1,120 ms, post about 920 to 1,010 ms; about 1.8 to 2.1 s per card.
- Replacing the clicked message through `response_url` with text only removes the image (also with `chat.update` and text only). Replacing through `response_url` with the same `slack_file` image block plus text keeps the image.

## Not verified (listed, not assumed)

- Whether `files:read` is needed (it was granted during the run).
- `chat.update` with the image block kept.
- Reusing one file id for another user (so: one upload per delivery).
- The click payload's `slack_file` shape: the code reads `id`, else `url`, from `body.message.blocks` and sends back only one of them (both together are refused by Slack); not confirmed on a live click. If nothing readable is found the replacement is text only and the image is dropped, logged as `image_ref_unreadable`.
- Whether the 0.5 s first wait is enough: the spike posted with no wait and needed one retry each time; the first wait is empirical and the backoff stays as the safety net.

## Choices

| # | choice | why |
| --- | --- | --- |
| 1 | `SlackPort.postCard(to, message, image?)` with `CardImage = {png, width, height, alt}` (`src/slack/port.ts`). The adapter uploads privately, waits `IMAGE_FIRST_WAIT_MS` (500), posts `[image, options section, actions]` with `text` = question plus options, and on `invalid_blocks` waits 0.5, 1, 2, 4, 8 s and posts again (the file is uploaded once per delivery). The budget is the sum, 15.5 s, plus the first wait: both are constants in `src/slack/web.ts` | the spike's result; bounded so a delivery never waits long |
| 2 | An image failure (upload error, no file id, Slack never accepted the block) is a `CardImageError` and nothing was posted; any other Slack error stays a `SlackPortError` and is not retried | the scheduler can tell "send text instead" from "Slack is down" |
| 3 | The scheduler's shared `postCard` (`sendNext`, the tick, the stale-claim re-send, the later reminders) renders per delivery and sends the image; a render error (a stored question the rule would now refuse), a render that throws (logged as `render_threw`), a `CardImageError`, or budget exhaustion sends the TEXT card and logs a short code (`unsupported_character`, `upload_failed`, `not_ready`, `no_file_id`; never bytes or a token). Other errors propagate: the claim stays and the tick re-posts (decision 0027) | a claimed card is never retried forever because of an image |
| 4 | No render cache and no file-id storage | the user's answer in 0033; a render is 12 to 170 ms |
| 5 | The text card (`buildCardMessage(card)`) is unchanged; with `imageAbove` it keeps only the options and the buttons because the question is on the image, and `text` still holds the question for notifications and screen readers | the user's layout |
| 6 | After a click, the rating prompt and the right and wrong outcomes are sent back through `response_url` with the same image block (the file id read from `body.message.blocks`; `id` preferred over `url`); `sent again`, `removed`, `course_over`, `not_open`, `not_enrolled` and the error text replace with text only (the image is dropped); a text card has no image block and is replaced as before | the spike showed this keeps and drops the image |
| 7 | REST: `POST /courses/:id/flashcards` cleans every question and checks it with `checkQuestion` (500 characters after cleaning, glyph check, measured fit) before the transaction; the cleaned text is stored. Codes `question_too_long`, `unsupported_character`, `empty_question`, all HTTP 400 (like `invalid_request`), message `Card N: ...` without the text; the batch is all or nothing. The 2,900 cap for question plus options stays | the services own the rule, so REST and MCP get it together |
| 8 | MCP: the `add_flashcards` description and the `question` field say 500 characters, plain text, supported characters, the three codes and "long context goes into the options or the material"; the schema does not repeat the check (the API is the authority) | a model reads the description before it writes cards |
| 9 | The trace records `<image 1200x630>` and the alt text for an image card, never bytes and no hash (a hash may differ per platform); the baseline `docs/baseline/trace.json` is NOT changed here: `scenario:compare` shows the diff for the user to accept | decision 0032 |
| 10 | The spike script and `spikeProbe` stay as diagnostic tools; the misleading "!! mimetype" warning is gone (empty values print as "not processed yet") | what the live run showed |

## Known limits

- About 2 s per card, sent one after another: about 30 minutes for 1,000 students at a start or a tick (no concurrency).
- The first post of a start is slow (upload plus the first wait), and every card waits at least 0.5 s.
- A rendering and upload outage degrades cards to text, silently for the student: the log line is the only sign.
- A stored question that the rule would refuse today (created before it) is sent as text.
- The image is dropped when the clicked message's file cannot be read from the payload, and on every refusal text.
- Reminders (6b-2) must go through the same `postCard` so they carry the image.
- A file that was uploaded but whose post then failed is not deleted (nothing calls `files.delete`); during a Slack outage each re-send uploads again.
- A card whose blocks are really invalid waits the whole 15.5 s before the text fallback.
- The REST check measures text synchronously: up to about 30 ms for one hostile card (a batch of 100 about 2.5 s in total); the service yields to the event loop between cards, so no single stall is longer than one card.
- The question is rendered in the main thread: 12 to 170 ms of blocked event loop per card.
