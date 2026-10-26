/** Thin REST client of the MCP server (decision 0007, 0030). The bearer token goes only into the Authorization header; no error text built here contains it, a request URL or a fetch error message. */
const MAX_BODY = 5_000_000;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface RetainApi {
  /** Resolves with the parsed JSON body (`{ ok: true }` for 204); rejects with `ApiError`. */
  request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown>;
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Throws a message that names the variable and never prints the value. */
export function readConfig(source: Record<string, string | undefined>): { baseUrl: string; token: string } {
  const url = source.RETAIN_API_URL?.trim();
  const token = source.RETAIN_API_TOKEN?.trim();
  if (!url) throw new Error('RETAIN_API_URL is not set (for example http://127.0.0.1:3000).');
  if (!token) throw new Error('RETAIN_API_TOKEN is not set (create one with: npm run teacher:token).');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('RETAIN_API_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('RETAIN_API_URL must start with http:// or https://.');
  if (parsed.username || parsed.password) throw new Error('RETAIN_API_URL must not contain a user name or password.');
  if (/[\s\x00-\x1f\x7f]/.test(token)) throw new Error('RETAIN_API_TOKEN must not contain whitespace or control characters.');
  return { baseUrl: parsed.origin + parsed.pathname.replace(/\/+$/, ''), token };
}

export function createRestClient(o: ClientOptions): RetainApi {
  const doFetch = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 15_000;
  const origin = new URL(o.baseUrl).origin;
  return {
    async request(method, path, body) {
      let res: Response;
      try {
        res = await doFetch(o.baseUrl + path, {
          method,
          headers: { authorization: `Bearer ${o.token}`, accept: 'application/json', ...(body !== undefined && { 'content-type': 'application/json' }) },
          ...(body !== undefined && { body: JSON.stringify(body) }),
          redirect: 'manual', // never followed: a redirect would carry the bearer token to another host
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // The fetch error text can hold the URL, so only the kind is reported.
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new ApiError(timedOut ? 'timeout' : 'unreachable', timedOut ? `The Retain API at ${origin} did not answer in time.` : `Could not reach the Retain API at ${origin}. Is the server running?`);
      }
      if (res.status >= 300 && res.status < 400) throw new ApiError('redirect', `The Retain API at ${origin} answered with a redirect (${res.status}); check RETAIN_API_URL.`, res.status);
      // shortcut: the size is checked after the body is read, so a hostile server can still make us buffer it; upgrade when the API URL is not the teacher's own.
      const text = await res.text().catch(() => '');
      if (text.length > MAX_BODY) throw new ApiError('bad_response', 'The Retain API answered with a body that is too large.', res.status);
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // handled below
      }
      if (res.ok) {
        if (res.status === 204) return { ok: true };
        if (json === null) throw new ApiError('bad_response', 'The Retain API answered with something that is not JSON.', res.status);
        return json;
      }
      const e = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      if (typeof e?.code === 'string' && typeof e.message === 'string') throw new ApiError(e.code.slice(0, 60), e.message.replaceAll(o.token, '[redacted]').slice(0, 500), res.status); // belt and braces: the API never echoes the token
      throw new ApiError('bad_response', `The Retain API answered with status ${res.status} and no error body.`, res.status);
    },
  };
}
