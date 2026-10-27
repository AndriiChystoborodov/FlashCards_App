/**
 * Helpers of the image-card spike (scripts/image-spike.ts, decision 0033): the image block, a summary of a Slack file object
 * and the "file not ready yet" retry. Spike only: nothing in production imports this file.
 */

export type ImageRef = { id: string } | { url: string };

/** The image block of docs.slack.dev: exactly `type`, `slack_file` (id or url, never both) and `alt_text`; no `image_url`. */
export function imageBlock(ref: ImageRef, alt: string) {
  return { type: 'image' as const, slack_file: 'id' in ref ? { id: ref.id } : { url: ref.url }, alt_text: alt.slice(0, 2000) };
}

/** A block as it may be printed: a url is never shown (a private file url is a credential of sorts). */
export const printableBlock = (block: ReturnType<typeof imageBlock>): string =>
  JSON.stringify('url' in block.slack_file ? { ...block, slack_file: { url: '<url_private>' } } : block);

/** The code of a failed Slack call: the platform's `data.error`, else the client's `code`, else `unknown`. */
export function slackCode(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const { data, code } = err as { data?: { error?: unknown }; code?: unknown };
    if (typeof data?.error === 'string') return data.error;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

/** The fields of a `files.info` file that matter for display. Only the presence of urls, never their value. */
export function describeFile(file: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!file) return { file: 'not returned' };
  const keys = Object.keys(file);
  const shares = file.shares as { public?: Record<string, unknown>; private?: Record<string, unknown> } | undefined;
  return {
    mimetype: file.mimetype || 'empty (not processed yet)',
    filetype: file.filetype || 'empty (not processed yet)',
    size: file.size,
    original_w: file.original_w,
    original_h: file.original_h,
    is_public: file.is_public,
    public_url_shared: file.public_url_shared,
    created: file.created,
    timestamp: file.timestamp,
    channels: file.channels,
    groups: file.groups,
    ims: file.ims,
    shared_in: shares ? [...Object.keys(shares.public ?? {}), ...Object.keys(shares.private ?? {})] : [],
    has_thumbnails: keys.some((k) => k.startsWith('thumb_')),
    has_url_private: typeof file.url_private === 'string',
    has_permalink: typeof file.permalink === 'string',
    file_access: file.file_access,
    is_external: file.is_external,
  };
}

/** Slack's answer for a block that cannot be shown yet or at all. */
export const NOT_READY = 'invalid_blocks';
export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;

export type Readiness<T> =
  | { ok: true; result: T; attempts: number; waitedMs: number }
  | { ok: false; code: string; attempts: number; waitedMs: number };

/**
 * Posts, and while Slack answers `invalid_blocks` waits and posts again (0.5, 1, 2, 4, 8 s). Any other error stops at once.
 * Tells how long it waited before Slack accepted the block, or that it never did.
 */
export async function postWithReadiness<T>(
  post: () => Promise<T>,
  opts: { backoffMs?: readonly number[]; onWait?: (waitMs: number, attempt: number) => void } = {},
): Promise<Readiness<T>> {
  const backoff = opts.backoffMs ?? BACKOFF_MS;
  let waitedMs = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: true, result: await post(), attempts: attempt, waitedMs };
    } catch (err) {
      const code = slackCode(err);
      const wait = backoff[attempt - 1];
      if (code !== NOT_READY || wait === undefined) return { ok: false, code, attempts: attempt, waitedMs };
      opts.onWait?.(wait, attempt);
      await new Promise((r) => setTimeout(r, wait));
      waitedMs += wait;
    }
  }
}
