import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOT_READY, describeFile, imageBlock, postWithReadiness, printableBlock, slackCode } from './spikeProbe.js';

const slackError = (code: string) => Object.assign(new Error('x'), { data: { error: code } });

describe('postWithReadiness', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('accepts at once without waiting', async () => {
    const post = vi.fn().mockResolvedValue('ts1');
    expect(await postWithReadiness(post)).toEqual({ ok: true, result: 'ts1', attempts: 1, waitedMs: 0 });
  });

  it('retries invalid_blocks with the 0.5, 1, 2 s backoff and reports the waited time', async () => {
    const post = vi.fn().mockRejectedValueOnce(slackError(NOT_READY)).mockRejectedValueOnce(slackError(NOT_READY)).mockRejectedValueOnce(slackError(NOT_READY)).mockResolvedValue('ts');
    const waits: number[] = [];
    const p = postWithReadiness(post, { onWait: (ms) => waits.push(ms) });
    await vi.advanceTimersByTimeAsync(3500);
    expect(await p).toEqual({ ok: true, result: 'ts', attempts: 4, waitedMs: 3500 });
    expect(waits).toEqual([500, 1000, 2000]);
  });

  it('gives up after the last backoff step and says it never worked', async () => {
    const post = vi.fn().mockRejectedValue(slackError(NOT_READY));
    const p = postWithReadiness(post);
    await vi.advanceTimersByTimeAsync(15_500);
    expect(await p).toEqual({ ok: false, code: NOT_READY, attempts: 6, waitedMs: 15_500 });
  });

  it('does not retry other errors', async () => {
    const post = vi.fn().mockRejectedValue(slackError('channel_not_found'));
    expect(await postWithReadiness(post)).toEqual({ ok: false, code: 'channel_not_found', attempts: 1, waitedMs: 0 });
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('helpers', () => {
  it('builds exactly {type, slack_file:{id}, alt_text} and truncates the alt text at 2000', () => {
    expect(imageBlock({ id: 'F1' }, 'q')).toEqual({ type: 'image', slack_file: { id: 'F1' }, alt_text: 'q' });
    expect(Object.keys(imageBlock({ id: 'F1' }, 'q')).sort()).toEqual(['alt_text', 'slack_file', 'type']);
    expect(imageBlock({ id: 'F1' }, 'x'.repeat(3000)).alt_text).toHaveLength(2000);
  });
  it('uses url instead of id, never both, and never prints the url', () => {
    const b = imageBlock({ url: 'https://files.example/secret' }, 'q');
    expect(b.slack_file).toEqual({ url: 'https://files.example/secret' });
    expect(printableBlock(b)).not.toContain('secret');
  });
  it('reads Slack error codes', () => {
    expect(slackCode(slackError('invalid_blocks'))).toBe('invalid_blocks');
    expect(slackCode({ code: 'slack_webapi_request_error' })).toBe('slack_webapi_request_error');
    expect(slackCode('boom')).toBe('unknown');
  });
  it('describes a file without urls', () => {
    const d = describeFile({ mimetype: 'image/png', filetype: 'png', size: 10, url_private: 'https://secret', thumb_64: 'https://t', shares: { private: { D1: [] } } });
    expect(d).toMatchObject({ mimetype: 'image/png', has_url_private: true, has_thumbnails: true, shared_in: ['D1'] });
    expect(JSON.stringify(d)).not.toContain('secret');
    expect(describeFile(undefined)).toEqual({ file: 'not returned' });
  });
});
