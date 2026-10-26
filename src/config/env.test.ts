import { describe, expect, it, vi } from 'vitest';

// Importing env.ts parses process.env once; give it a valid one and keep the real .env out.
vi.mock('dotenv/config', () => ({}));
vi.hoisted(() => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_APP_TOKEN = 'xapp-test';
  process.env.SLACK_TEST_USER_ID = 'U123';
});

const { parseEnv } = await import('./env.js');

const socket = { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test', SLACK_TEST_USER_ID: 'U123', DATABASE_URL: 'postgres://x' };
const http = { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test', SLACK_MODE: 'http', SLACK_SIGNING_SECRET: 'secret', DATABASE_URL: 'postgres://x' };

describe('parseEnv', () => {
  it('accepts a minimal socket-mode env and applies defaults', () => {
    expect(parseEnv(socket)).toEqual({
      ...socket,
      NODE_ENV: 'development',
      SLACK_MODE: 'socket',
      TENANT_TIMEZONE: 'UTC',
      SEND_HOUR: 9,
      TICK_MINUTES: 15,
      REMOVED_RETENTION_DAYS: 14,
      STUDENT_ROUTES_ENABLED: false,
    });
  });

  it('accepts a minimal http-mode env without SLACK_TEST_USER_ID', () => {
    expect(parseEnv(http).SLACK_MODE).toBe('http');
  });

  it('treats empty strings as unset (as in .env.example)', () => {
    const e = parseEnv({ ...socket, NODE_ENV: 'test', SEND_HOUR: '', TENANT_TIMEZONE: '', DATABASE_URL: '', SLACK_SIGNING_SECRET: '' });
    expect(e.SEND_HOUR).toBe(9);
    expect(e.DATABASE_URL).toBeUndefined();
  });

  it('accepts all optional values', () => {
    const e = parseEnv({
      ...socket,
      NODE_ENV: 'test',
      TENANT_TIMEZONE: 'Europe/Zurich',
      SEND_HOUR: '0',
      REMOVED_RETENTION_DAYS: '30',
      STUDENT_ROUTES_ENABLED: 'true',
      DATABASE_URL: 'postgres://x',
    });
    expect(e).toMatchObject({ NODE_ENV: 'test', SEND_HOUR: 0, REMOVED_RETENTION_DAYS: 30, STUDENT_ROUTES_ENABLED: true });
  });

  it.each(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_TEST_USER_ID'])('fails when %s is missing in socket mode', (key) => {
    const { [key]: _omit, ...rest } = socket as Record<string, string>;
    expect(() => parseEnv(rest)).toThrow(key);
  });

  it('fails without SLACK_SIGNING_SECRET in http mode', () => {
    const { SLACK_SIGNING_SECRET: _omit, ...rest } = http;
    expect(() => parseEnv(rest)).toThrow('SLACK_SIGNING_SECRET');
  });

  it('fails on wrong token prefixes without printing the value', () => {
    expect(() => parseEnv({ ...socket, SLACK_BOT_TOKEN: 'xapp-leaky' })).toThrow('SLACK_BOT_TOKEN');
    expect(() => parseEnv({ ...socket, SLACK_APP_TOKEN: 'xoxb-leaky' })).toThrow('SLACK_APP_TOKEN');
    try {
      parseEnv({ ...socket, SLACK_BOT_TOKEN: 'xapp-leaky' });
    } catch (err) {
      expect(String(err)).not.toContain('leaky');
    }
  });

  it.each([
    ['NODE_ENV', 'staging'],
    ['SLACK_MODE', 'websocket'],
    ['SEND_HOUR', '24'],
    ['SEND_HOUR', '-1'],
    ['SEND_HOUR', '9.5'],
    ['SEND_HOUR', 'nine'],
    ['TENANT_TIMEZONE', 'Mars/Olympus'],
    ['REMOVED_RETENTION_DAYS', '0'],
    ['REMOVED_RETENTION_DAYS', '1.5'],
    ['STUDENT_ROUTES_ENABLED', '1'],
  ])('fails on %s=%s', (key, value) => {
    expect(() => parseEnv({ ...socket, [key]: value })).toThrow(key);
  });

  it('requires DATABASE_URL unless NODE_ENV=test', () => {
    const { DATABASE_URL: _omit, ...rest } = socket;
    expect(() => parseEnv(rest)).toThrow('DATABASE_URL');
    expect(() => parseEnv({ ...rest, NODE_ENV: 'production' })).toThrow('DATABASE_URL');
    expect(parseEnv({ ...rest, NODE_ENV: 'test' }).DATABASE_URL).toBeUndefined();
  });

  it('refuses STUDENT_ROUTES_ENABLED=true in production (R20)', () => {
    expect(() => parseEnv({ ...socket, NODE_ENV: 'production', STUDENT_ROUTES_ENABLED: 'true' })).toThrow(
      /STUDENT_ROUTES_ENABLED.*production/,
    );
    expect(parseEnv({ ...socket, NODE_ENV: 'production' }).STUDENT_ROUTES_ENABLED).toBe(false);
  });
});
