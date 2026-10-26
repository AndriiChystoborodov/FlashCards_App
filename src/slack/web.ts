import type { types } from '@slack/bolt';
import type { CardMessage } from './card.js';
import type { SlackPort } from './port.js';

type KnownBlock = types.KnownBlock;

/** The calls of Bolt's `WebClient` the adapter uses; the client is assignable to it, a test stub too. */
export interface SlackWebApi {
  chat: {
    postMessage(a: { channel: string; text: string; blocks: KnownBlock[] }): Promise<{ channel?: string; ts?: string }>;
    update(a: { channel: string; ts: string; text: string; blocks: KnownBlock[] }): Promise<unknown>;
  };
  users: { lookupByEmail(a: { email: string }): Promise<{ user?: { id?: string; tz?: string } }> };
}

/**
 * A failed Slack call. Carries Slack's error code (`channel_not_found`, `ratelimited`, `request_error`, ...) and nothing else:
 * the client's own errors can hold request details, so they are never passed on.
 */
export class SlackPortError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}`);
    this.name = 'SlackPortError';
  }
}

/** The code of a `@slack/web-api` error: the platform's `data.error`, else the client's own `code`, else `unknown`. */
function codeOf(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const { data, code } = err as { data?: { error?: unknown }; code?: unknown };
    if (typeof data?.error === 'string') return data.error;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

async function call<T>(method: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new SlackPortError(method, codeOf(err));
  }
}

/**
 * `SlackPort` over the Web API (docs/slack/integration.md). `chat.postMessage` with a user id as `channel` opens the DM (only
 * `chat:write`), and answers with the `D...` channel. A rejected post means nothing was sent: the scheduler keeps the claim and
 * the tick re-posts it (decision 0027). Retries and the timeout belong to the client (see `src/slack/start.ts`).
 */
export function slackPort(web: SlackWebApi): SlackPort {
  return {
    async postCard(to, m: CardMessage) {
      const r = await call('chat.postMessage', () => web.chat.postMessage({ channel: to, text: m.text, blocks: m.blocks }));
      if (!r.channel || !r.ts) throw new SlackPortError('chat.postMessage', 'missing_channel_or_ts');
      return { channel: r.channel, ts: r.ts };
    },
    async replaceMessage(channel, ts, m) {
      await call('chat.update', () => web.chat.update({ channel, ts, text: m.text, blocks: m.blocks }));
    },
    async lookupEmail(email) {
      try {
        const r = await web.users.lookupByEmail({ email });
        return r.user?.id ? { slackId: r.user.id, tz: r.user.tz ?? null } : null;
      } catch (err) {
        const code = codeOf(err);
        if (code === 'users_not_found') return null;
        throw new SlackPortError('users.lookupByEmail', code);
      }
    },
  };
}
