import type { types } from '@slack/bolt';
import { imageBlock, type CardMessage } from './card.js';
import { CardImageError, type CardImage, type SlackPort } from './port.js';

type KnownBlock = types.KnownBlock;

/** The calls of Bolt's `WebClient` the adapter uses; the client is assignable to it, a test stub too. */
export interface SlackWebApi {
  chat: {
    postMessage(a: { channel: string; text: string; blocks: KnownBlock[] }): Promise<{ channel?: string; ts?: string }>;
    update(a: { channel: string; ts: string; text: string; blocks: KnownBlock[] }): Promise<unknown>;
  };
  /** `filesUploadV2` answers one `completeUploadExternal` result per group: the file id is at `files[0].files[0].id` (SDK 8.2.0). */
  filesUploadV2(a: { file: Buffer; filename: string; alt_text: string }): Promise<{ files?: { files?: { id?: string }[] }[] }>;
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

/**
 * Image cards (decision 0034). The spike showed that a post right after the upload is answered `invalid_blocks` (the file is not
 * processed yet): all four cards were accepted by the retry after 0.5 s. So the first post waits `IMAGE_FIRST_WAIT_MS` and an
 * `invalid_blocks` answer is retried with `IMAGE_RETRY_BACKOFF_MS`; the budget is the sum of all waits (15.5 s), then the image is given up.
 */
export const IMAGE_FIRST_WAIT_MS = 500;
export const IMAGE_RETRY_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;

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
export function slackPort(web: SlackWebApi, opts: { sleep?: (ms: number) => Promise<void> } = {}): SlackPort {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** Uploads privately (no `channel_id`) and returns the file id. Any failure is a `CardImageError`: nothing was posted yet. */
  async function upload(image: CardImage): Promise<string> {
    let res;
    try {
      res = await web.filesUploadV2({ file: image.png, filename: 'card.png', alt_text: image.alt.slice(0, 1000) });
    } catch (err) {
      console.warn(`card image upload failed: ${codeOf(err)}`);
      throw new CardImageError('upload_failed');
    }
    const id = res.files?.[0]?.files?.[0]?.id;
    if (!id) throw new CardImageError('no_file_id');
    return id;
  }

  /** Posts the card with the image block first; `invalid_blocks` means the file is not ready: wait and post again, then give up. */
  async function postWithImage(to: string, m: CardMessage, image: CardImage): Promise<{ channel?: string; ts?: string }> {
    const id = await upload(image);
    const blocks = [imageBlock({ id }, image.alt), ...m.blocks] as KnownBlock[];
    await sleep(IMAGE_FIRST_WAIT_MS);
    for (let attempt = 0; ; attempt++) {
      try {
        return await web.chat.postMessage({ channel: to, text: m.text, blocks });
      } catch (err) {
        const code = codeOf(err);
        const wait = IMAGE_RETRY_BACKOFF_MS[attempt];
        if (code !== 'invalid_blocks') throw new SlackPortError('chat.postMessage', code);
        if (wait === undefined) throw new CardImageError('not_ready');
        await sleep(wait);
      }
    }
  }

  return {
    async postCard(to, m: CardMessage, image?: CardImage) {
      const r = image ? await postWithImage(to, m, image) : await call('chat.postMessage', () => web.chat.postMessage({ channel: to, text: m.text, blocks: m.blocks }));
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
