import type { CardMessage } from './card.js';
import { CardImageError, type CardImage, type SlackPort } from './port.js';

export interface PostedMessage {
  to: string;
  channel: string;
  ts: string;
  message: CardMessage;
  /** Present when the card was posted with its image. */
  image?: CardImage;
}

/** Records every call; used by service tests and the scenario script. */
export class FakeSlack implements SlackPort {
  posted: PostedMessage[] = [];
  replaced: { channel: string; ts: string; message: CardMessage }[] = [];
  directory = new Map<string, { slackId: string; tz: string | null }>();
  /** When set, the next postCard rejects with this error (a Slack outage after the claim). */
  failNextPost: Error | null = null;
  /** When set, the next postCard WITH an image rejects with this error and posts nothing (an upload or readiness failure). */
  failNextImage: CardImageError | null = null;
  private counter = 0;

  async postCard(to: string, message: CardMessage, image?: CardImage): Promise<{ channel: string; ts: string }> {
    if (image && this.failNextImage) {
      const err = this.failNextImage;
      this.failNextImage = null;
      throw err;
    }
    if (this.failNextPost) {
      const err = this.failNextPost;
      this.failNextPost = null;
      throw err;
    }
    const channel = to.startsWith('D') ? to : `D-${to}`;
    const ts = `${(this.counter += 1)}.000100`;
    this.posted.push({ to, channel, ts, message, ...(image && { image }) });
    return { channel, ts };
  }

  async replaceMessage(channel: string, ts: string, message: CardMessage): Promise<void> {
    this.replaced.push({ channel, ts, message });
  }

  async lookupEmail(email: string): Promise<{ slackId: string; tz: string | null } | null> {
    return this.directory.get(email) ?? null;
  }
}
