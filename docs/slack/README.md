# Slack app

`manifest.dev.yaml` describes how the development Slack app is configured. It is a record of the app's settings and a way to create the app in one step.

## Settings that matter

| Setting                                 | What it does                           | Why we need it                                                   |
| --------------------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| `app_home.messages_tab_enabled: true`   | The bot has a DM tab                   | Students receive and answer cards there                          |
| `messages_tab_read_only_enabled: false` | Users can write in that tab            | Students must be able to interact with the bot                   |
| `chat:write`                            | Send messages                          | Send cards and notifications                                     |
| `users:read`                            | Read the workspace user list           | Find students in Slack                                           |
| `users:read.email`                      | See users' emails                      | Match students from our database to Slack accounts by email      |
| `interactivity.is_enabled: true`        | Button clicks are delivered to the app | Students answer by clicking buttons                              |
| `socket_mode_enabled: true`             | Events arrive over a WebSocket         | The bot runs on a laptop without a public URL (development only) |

The remaining settings (`display_information`, `always_online`, `org_deploy_enabled`, `token_rotation_enabled`) are cosmetic or turn off features we don't use.

## Why it is in the repo

- **Create the app .** On api.slack.com/apps choose _Create New App → From a manifest_, pick the workspace and paste the file. All settings below are applied at once.
- **Know what the bot is allowed to do.** If the code needs a Slack API method that requires a scope not listed here, add the scope to the manifest, update the app and reinstall it.
- **Base for the production app.** The production app will use the same manifest with Socket Mode turned off and HTTP request URLs added.

The manifest contains no secrets. Tokens and the signing secret live only in `.env`.

## Setup

1. Create a free test workspace in Slack.
2. Create the app from `manifest.dev.yaml` and click _Install to Workspace_.
3. Copy the tokens into `.env`:
   - `SLACK_BOT_TOKEN` (`xoxb-…`) — _OAuth & Permissions → Bot User OAuth Token_
   - `SLACK_APP_TOKEN` (`xapp-…`) — _Basic Information → App-Level Tokens_, create one with the `connections:write` scope
   - `SLACK_SIGNING_SECRET` — _Basic Information → Signing Secret_ (not used in Socket Mode, needed later for HTTP)
   - `SLACK_TEST_USER_ID` — your own member id (Slack profile → ⋯ → Copy member ID); only `npm run spike` needs it

## Changing settings

Change the app on api.slack.com, then copy the updated manifest from _App Manifest_ back into this file, so the repo always matches the real app. Changing scopes requires reinstalling the app to the workspace.
