import { describe, expect, it, vi } from 'vitest';
import { buildCardMessage, textOnly } from './card.js';
import { CardImageError, type CardImage } from './port.js';
import { IMAGE_FIRST_WAIT_MS, IMAGE_RETRY_BACKOFF_MS, SlackPortError, slackPort, type SlackWebApi } from './web.js';

const platformError = (error: string) => Object.assign(new Error('An API error occurred: ' + error + ' xoxb-LEAK'), { code: 'slack_webapi_platform_error', data: { ok: false, error } });

function stub(over: { upload?: () => Promise<{ files?: { files?: { id?: string }[] }[] }>; post?: () => Promise<{ channel?: string; ts?: string }>; update?: () => Promise<unknown>; lookup?: () => Promise<{ user?: { id?: string; tz?: string } }> } = {}) {
  const web = {
    chat: { postMessage: vi.fn(over.post ?? (async () => ({ channel: 'D1', ts: '1.1' }))), update: vi.fn(over.update ?? (async () => ({}))) },
    filesUploadV2: vi.fn(over.upload ?? (async () => ({ files: [{ files: [{ id: 'F123' }] }] }))),
    users: { lookupByEmail: vi.fn(over.lookup ?? (async () => ({ user: { id: 'U1', tz: 'Europe/Zurich' } }))) },
  } satisfies SlackWebApi;
  const sleeps: number[] = [];
  return { web, sleeps, port: slackPort(web, { sleep: async (ms) => void sleeps.push(ms) }) };
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

  describe('image cards (decision 0034)', () => {
    const image: CardImage = { png: Buffer.from('PNGBYTES'), width: 1200, height: 630, alt: 'What is it?' };
    const card = { id: 'c1', question: 'What is it?', options: ['a', 'b'] };
    const msg = buildCardMessage(card, { imageAbove: true });

    it('uploads privately first, waits, then posts the image block before the options with text and alt set', async () => {
      const order: string[] = [];
      const { web, sleeps, port } = stub({
        upload: async () => (order.push('upload'), { files: [{ files: [{ id: 'F123' }] }] }),
        post: async () => (order.push('post'), { channel: 'D1', ts: '9.9' }),
      });
      expect(await port.postCard('U1', msg, image)).toEqual({ channel: 'D1', ts: '9.9' });
      expect(order).toEqual(['upload', 'post']);
      expect(web.filesUploadV2).toHaveBeenCalledWith({ file: image.png, filename: 'card.png', alt_text: 'What is it?' }); // no channel_id: private
      expect(sleeps).toEqual([IMAGE_FIRST_WAIT_MS]);
      const sent = (web.chat.postMessage.mock.calls as unknown as [unknown][])[0]![0] as { channel: string; text: string; blocks: { type: string; slack_file?: unknown; alt_text?: string }[] };
      expect(sent.text).toBe(msg.text);
      expect(sent.text).toContain('What is it?');
      expect(sent.blocks.map((b) => b.type)).toEqual(['image', 'section', 'actions']);
      expect(sent.blocks[0]).toEqual({ type: 'image', slack_file: { id: 'F123' }, alt_text: 'What is it?' });
    });

    it('retries invalid_blocks with the backoff and accepts the post that works', async () => {
      let n = 0;
      const { web, sleeps, port } = stub({ post: async () => { if ((n += 1) < 3) throw platformError('invalid_blocks'); return { channel: 'D1', ts: '1.1' }; } });
      await port.postCard('U1', msg, image);
      expect(web.chat.postMessage).toHaveBeenCalledTimes(3);
      expect(sleeps).toEqual([IMAGE_FIRST_WAIT_MS, 500, 1000]);
      expect(web.filesUploadV2).toHaveBeenCalledTimes(1); // the file is uploaded once per delivery, not per attempt
    });

    it('gives up after the whole backoff (15.5 s) with CardImageError not_ready', async () => {
      const { web, sleeps, port } = stub({ post: async () => { throw platformError('invalid_blocks'); } });
      const err = await port.postCard('U1', msg, image).catch((e) => e);
      expect(err).toBeInstanceOf(CardImageError);
      expect(err.code).toBe('not_ready');
      expect(web.chat.postMessage).toHaveBeenCalledTimes(IMAGE_RETRY_BACKOFF_MS.length + 1);
      expect(sleeps.slice(1).reduce((a, b) => a + b, 0)).toBe(15_500);
    });

    it('does not retry any other Slack error: it is a SlackPortError with the code', async () => {
      const { web, port } = stub({ post: async () => { throw platformError('channel_not_found'); } });
      await expect(port.postCard('U1', msg, image)).rejects.toMatchObject({ method: 'chat.postMessage', code: 'channel_not_found' });
      expect(web.chat.postMessage).toHaveBeenCalledTimes(1);
    });

    it('an upload failure is a CardImageError and nothing is posted; no token or request detail leaks', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { web, port } = stub({ upload: async () => { throw platformError('missing_scope'); } });
      const err = await port.postCard('U1', msg, image).catch((e) => e);
      expect(err).toBeInstanceOf(CardImageError);
      expect(err.code).toBe('upload_failed');
      expect(web.chat.postMessage).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('LEAK');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('PNGBYTES');
      warn.mockRestore();
    });

    it('an upload answer without a file id is a CardImageError no_file_id', async () => {
      const { port } = stub({ upload: async () => ({ files: [{}] }) });
      await expect(port.postCard('U1', msg, image)).rejects.toMatchObject({ code: 'no_file_id' });
    });

    it('a post without an image is unchanged: no upload, no wait', async () => {
      const { web, sleeps, port } = stub();
      await port.postCard('U1', textOnly('hi'));
      expect(web.filesUploadV2).not.toHaveBeenCalled();
      expect(sleeps).toEqual([]);
    });
  });
});
