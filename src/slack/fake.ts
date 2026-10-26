import type { CardMessage } from './card.js';
import type { SlackPort } from './port.js';

export interface PostedMessage {
  to: string;
  channel: string;
  ts: string;
  message: CardMessage;
}

/** Records every call; used by service tests and the scenario script. */
export class FakeSlack implements SlackPort {
  posted: PostedMessage[] = [];
  replaced: { channel: string; ts: string; message: CardMessage }[] = [];
  directory = new Map<string, { slackId: string; tz: string | null }>();
  /** When set, the next postCard rejects with this error (a Slack outage after the claim). */
  failNextPost: Error | null = null;
  private counter = 0;

  async postCard(to: string, message: CardMessage): Promise<{ channel: string; ts: string }> {
    if (this.failNextPost) {
      const err = this.failNextPost;
      this.failNextPost = null;
      throw err;
    }
    const channel = to.startsWith('D') ? to : `D-${to}`;
    const ts = `${(this.counter += 1)}.000100`;
    this.posted.push({ to, channel, ts, message });
    return { channel, ts };
  }

  async replaceMessage(channel: string, ts: string, message: CardMessage): Promise<void> {
    this.replaced.push({ channel, ts, message });
  }

  async lookupEmail(email: string): Promise<{ slackId: string; tz: string | null } | null> {
    return this.directory.get(email) ?? null;
  }
}
