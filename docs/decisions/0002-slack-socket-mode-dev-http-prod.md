# 0002. Slack: Socket Mode in dev, HTTP on the Express app in prod

## Context

[Decision 0001](0001-express-web-framework.md) says Bolt runs on the same Express app. That holds only for HTTP mode: `ExpressReceiver({ app })` mounts `POST /slack/events` on our app. `SocketModeReceiver` takes no Express app and runs its own small server. Roadmap Task 2 uses Socket Mode (no public URL on a laptop).

## Options

- **Socket Mode everywhere.** One code path, but Slack does not allow Socket Mode apps in the Marketplace and it needs a persistent WebSocket per instance.
- **HTTP everywhere.** Needs a public URL even in dev.
- **Socket Mode in dev, HTTP in prod, chosen by one env flag.**

## Choice

The third. `SLACK_MODE=socket|http`. Dev: our `express()` app serves REST and a separate Bolt `App({ socketMode: true })` runs in the same process. Prod: `ExpressReceiver({ signingSecret, app })`.

Chosen by the user on 2026-10-24.

## Why

Handlers, services and the Slack interface are identical in both modes. Only the construction in `src/slack/` differs. Update the wording of 0001 ("Bolt works on Express") to mean HTTP mode only.
