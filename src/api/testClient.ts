import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

/** Tests and the scenario call the app over real HTTP on 127.0.0.1 only (Node's fetch, no extra dependency). */
export interface Api {
  url: string;
  close(): Promise<void>;
  call(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
}

export async function listen(app: Express): Promise<Api> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => server.once('listening', resolve).once('error', reject));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
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
