import type { ApiDeps } from './app.js';
import { startServer } from './server.js';

/** Tests and the scenario call the app over real HTTP on a loopback host (Node's fetch, no extra dependency). */
export interface Api {
  url: string;
  close(): Promise<void>;
  call(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
}

export async function listen(deps: ApiDeps): Promise<Api> {
  const s = await startServer(deps);
  const url = `http://${s.host.includes(':') ? `[${s.host}]` : s.host}:${s.port}`;
  return {
    url,
    close: s.close,
    async call(token, method, path, body) {
      const res = await fetch(url + path, {
        method,
        headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body !== undefined && { 'content-type': 'application/json' }) },
        ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
  };
}
