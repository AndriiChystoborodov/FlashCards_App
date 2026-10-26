import type { CardMessage } from './card.js';

/**
 * What the services need from Slack (docs/slack/integration.md, "Testing without Slack"). The recording fake is in `fake.ts`;
 * the Bolt implementation is Task 8.
 */
export interface SlackPort {
  /** Posts a DM. `to` is the cached DM channel (`D...`) or the Slack user id (`U...`), which opens the DM. */
  postCard(to: string, message: CardMessage): Promise<{ channel: string; ts: string }>;
  replaceMessage(channel: string, ts: string, message: CardMessage): Promise<void>;
  /** `users.lookupByEmail` plus `users.info` for the time zone; null when the email has no Slack user. */
  lookupEmail(email: string): Promise<{ slackId: string; tz: string | null } | null>;
}
