import { describe, expect, it } from 'vitest';
import { ApiError, createRestClient, readConfig } from './client.js';

describe('readConfig', () => {
  it('names the missing variable', () => {
    expect(() => readConfig({ RETAIN_API_TOKEN: 'abc' })).toThrow('RETAIN_API_URL is not set');
    expect(() => readConfig({ RETAIN_API_URL: 'http://127.0.0.1:3000' })).toThrow('RETAIN_API_TOKEN is not set');
    expect(() => readConfig({ RETAIN_API_URL: '  ', RETAIN_API_TOKEN: 'abc' })).toThrow('RETAIN_API_URL is not set');
  });
  it('rejects a bad URL without printing it, or the token', () => {
    for (const url of ['not a url', 'ftp://x.test', 'http://user:pw@x.test', 'file:///etc/passwd']) {
      try {
        readConfig({ RETAIN_API_URL: url, RETAIN_API_TOKEN: 'tok_SECRET' });
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as Error).message).toMatch(/^RETAIN_API_URL/);
        expect((e as Error).message).not.toContain('pw');
        expect((e as Error).message).not.toContain('tok_SECRET');
        expect((e as Error).message).not.toContain(url);
      }
    }
  });
  it('rejects a token with whitespace and trims the URL path', () => {
    expect(() => readConfig({ RETAIN_API_URL: 'http://x.test', RETAIN_API_TOKEN: 'a b' })).toThrow('RETAIN_API_TOKEN must not contain whitespace or control characters');
    expect(() => readConfig({ RETAIN_API_URL: 'http://x.test', RETAIN_API_TOKEN: 'a\u0000b' })).toThrow('control characters');
    expect(readConfig({ RETAIN_API_URL: 'http://x.test:3000/', RETAIN_API_TOKEN: 'abc' })).toEqual({ baseUrl: 'http://x.test:3000', token: 'abc' });
  });
});

describe('createRestClient', () => {
  it('does not follow redirects (the bearer token must stay on the configured host)', async () => {
    let init: RequestInit | undefined;
    const api = createRestClient({ baseUrl: 'http://x.test', token: 'tok', fetchImpl: (async (_u: string, i: RequestInit) => ((init = i), Response.json({}))) as unknown as typeof fetch });
    await api.request('GET', '/courses');
    expect(init!.redirect).toBe('manual');
  });
  it('a redirect answer is its own error and the body is not read as data', async () => {
    const api = createRestClient({ baseUrl: 'http://x.test', token: 'tok', fetchImpl: (async () => new Response(null, { status: 307, headers: { location: 'http://evil.test' } })) as unknown as typeof fetch });
    await expect(api.request('GET', '/courses')).rejects.toMatchObject({ code: 'redirect' });
  });
  it('refuses a huge body', async () => {
    const api = createRestClient({ baseUrl: 'http://x.test', token: 'tok', fetchImpl: (async () => new Response('x'.repeat(5_000_001))) as unknown as typeof fetch });
    await expect(api.request('GET', '/courses')).rejects.toMatchObject({ code: 'bad_response' });
  });
  it('times out with a message that has no URL path', async () => {
    const api = createRestClient({ baseUrl: 'http://x.test', token: 'tok', timeoutMs: 20, fetchImpl: ((_u: string, i: RequestInit) => new Promise((_r, rej) => i.signal!.addEventListener('abort', () => rej(i.signal!.reason)))) as unknown as typeof fetch });
    await expect(api.request('GET', '/courses/secret-path')).rejects.toMatchObject({ code: 'timeout' });
    await expect(api.request('GET', '/courses/secret-path')).rejects.toBeInstanceOf(ApiError);
  });
});
