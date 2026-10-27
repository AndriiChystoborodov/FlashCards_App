import type { CardMessage } from './card.js';

/** The generated image of a card question (src/render). `alt` is the sanitized question; the PNG never leaves the process except to Slack. */
export interface CardImage {
  png: Buffer;
  width: number;
  height: number;
  alt: string;
}

/**
 * The image of a card could not be shown: the upload failed or Slack never accepted the image block. Nothing was posted, so the
 * caller may send the text card instead. `code` is a short reason, never a payload or a token.
 */
export class CardImageError extends Error {
  constructor(readonly code: 'upload_failed' | 'not_ready' | 'no_file_id') {
    super(`card image unavailable: ${code}`);
    this.name = 'CardImageError';
  }
}

/**
 * What the services need from Slack (docs/slack/integration.md, "Testing without Slack"). The recording fake is in `fake.ts`;
 * the Bolt implementation is Task 8.
 */
export interface SlackPort {
  /**
   * Posts a DM. `to` is the cached DM channel (`D...`) or the Slack user id (`U...`), which opens the DM. With `image`, the PNG is
   * uploaded and shown above `message` (decision 0034); a failure of the image alone is a `CardImageError`.
   */
  postCard(to: string, message: CardMessage, image?: CardImage): Promise<{ channel: string; ts: string }>;
  replaceMessage(channel: string, ts: string, message: CardMessage): Promise<void>;
  /** `users.lookupByEmail` (its answer already holds the time zone); null when the email has no Slack user. */
  lookupEmail(email: string): Promise<{ slackId: string; tz: string | null } | null>;
}
