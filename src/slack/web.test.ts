import { describe, expect, it, vi } from 'vitest';
import { textOnly } from './card.js';
import { SlackPortError, slackPort, type SlackWebApi } from './web.js';

const platformError = (error: string) => Object.assign(new Error('An API error occurred: ' + error + ' xoxb-LEAK'), { code: 'slack_webapi_platform_error', data: { ok: false, error } });

function stub(over: { post?: () => Promise<{ channel?: string; ts?: string }>; update?: () => Promise<unknown>; lookup?: () => Promise<{ user?: { id?: string; tz?: string } }> } = {}) {
  const web = {
    chat: { postMessage: vi.fn(over.post ?? (async () => ({ channel: 'D1', ts: '1.1' }))), update: vi.fn(over.update ?? (async () => ({}))) },
    users: { lookupByEmail: vi.fn(over.lookup ?? (async () => ({ user: { id: 'U1', tz: 'Europe/Zurich' } }))) },
  } satisfies SlackWebApi;
  return { web, port: slackPort(web) };
}

describe('slackPort', () => {
  it('postCard posts text and blocks to the user id or channel and returns the DM channel and ts', async () => {
    const { web, port } = stub();
    const m = textOnly('hello');
    expect(await port.postCard('U1', m)).toEqual({ channel: 'D1', ts: '1.1' });
    expect(web.chat.postMessage).toHaveBeenCalledWith({ channel: 'U1', text: 'hello', blocks: m.blocks });
  });

  it('postCard throws a SlackPortError with only the code when Slack refuses, and never the client error', async () => {
    const { port } = stub({ post: async () => { throw platformError('channel_not_found'); } });
    const err = await port.postCard('U1', textOnly('x')).catch((e) => e);
    expect(err).toBeInstanceOf(SlackPortError);
    expect(err).toMatchObject({ method: 'chat.postMessage', code: 'channel_not_found' });
    expect(JSON.stringify([err.message, err.code, err.stack?.includes('LEAK')])).not.toContain('LEAK');
    expect(err.message).toBe('Slack chat.postMessage failed: channel_not_found');
  });

  it('a network failure becomes the client error code; an unknown failure is "unknown"', async () => {
    const a = stub({ post: async () => { throw Object.assign(new Error('xoxb-LEAK'), { code: 'slack_webapi_request_error' }); } });
    await expect(a.port.postCard('U1', textOnly('x'))).rejects.toMatchObject({ code: 'slack_webapi_request_error' });
    const b = stub({ post: async () => { throw 'weird'; } });
    await expect(b.port.postCard('U1', textOnly('x'))).rejects.toMatchObject({ code: 'unknown' });
  });

  it('a response without channel or ts is an error, not a card with an undefined message', async () => {
    const { port } = stub({ post: async () => ({}) });
    await expect(port.postCard('U1', textOnly('x'))).rejects.toMatchObject({ code: 'missing_channel_or_ts' });
  });

  it('replaceMessage updates by channel and ts with the new blocks (no buttons) and reports failures by code', async () => {
    const { web, port } = stub();
    const m = textOnly('expired');
    await port.replaceMessage('D1', '1.1', m);
    expect(web.chat.update).toHaveBeenCalledWith({ channel: 'D1', ts: '1.1', text: 'expired', blocks: m.blocks });
    const bad = stub({ update: async () => { throw platformError('message_not_found'); } });
    await expect(bad.port.replaceMessage('D1', '1.1', m)).rejects.toMatchObject({ method: 'chat.update', code: 'message_not_found' });
  });

  it('lookupEmail returns the id and time zone, null for users_not_found, and a coded error for anything else', async () => {
    expect(await stub().port.lookupEmail('a@x.test')).toEqual({ slackId: 'U1', tz: 'Europe/Zurich' });
    expect(await stub({ lookup: async () => ({ user: { id: 'U2' } }) }).port.lookupEmail('a@x.test')).toEqual({ slackId: 'U2', tz: null });
    expect(await stub({ lookup: async () => { throw platformError('users_not_found'); } }).port.lookupEmail('a@x.test')).toBeNull();
    expect(await stub({ lookup: async () => ({}) }).port.lookupEmail('a@x.test')).toBeNull();
    await expect(stub({ lookup: async () => { throw platformError('ratelimited'); } }).port.lookupEmail('a@x.test')).rejects.toMatchObject({ method: 'users.lookupByEmail', code: 'ratelimited' });
  });
});
