import { describe, expect, it } from 'vitest';
import { dueNotAfter, endOfLocalDay, isValidTimezone } from './localDay.js';

const Z = 'Europe/Zurich';
const iso = (d: Date) => d.toISOString();

describe('endOfLocalDay', () => {
  it('winter day in Zurich ends at 22:59:59.999Z', () => {
    expect(iso(endOfLocalDay(Z, new Date('2026-01-15T09:20:00Z')))).toBe('2026-01-15T22:59:59.999Z');
  });
  it('spring-forward day (23 h): 2026-03-29', () => {
    const end = endOfLocalDay(Z, new Date('2026-03-29T10:00:00Z'));
    expect(iso(end)).toBe('2026-03-29T21:59:59.999Z');
    expect((end.getTime() - endOfLocalDay(Z, new Date('2026-03-28T12:00:00Z')).getTime()) / 3.6e6).toBe(23);
  });
  it('fall-back day (25 h): 2026-10-25', () => {
    const end = endOfLocalDay(Z, new Date('2026-10-25T10:00:00Z'));
    expect(iso(end)).toBe('2026-10-25T22:59:59.999Z');
    expect((end.getTime() - endOfLocalDay(Z, new Date('2026-10-24T12:00:00Z')).getTime()) / 3.6e6).toBe(25);
  });
  it('a moment just after local midnight belongs to the new local day', () => {
    expect(iso(endOfLocalDay(Z, new Date('2026-01-14T23:00:01Z')))).toBe('2026-01-15T22:59:59.999Z');
  });
  it('zones whose day differs from UTC, including half-hour offsets', () => {
    expect(iso(endOfLocalDay('Pacific/Auckland', new Date('2026-01-15T20:00:00Z')))).toBe('2026-01-16T10:59:59.999Z');
    expect(iso(endOfLocalDay('America/Los_Angeles', new Date('2026-01-16T03:00:00Z')))).toBe('2026-01-16T07:59:59.999Z');
    expect(iso(endOfLocalDay('Asia/Kolkata', new Date('2026-01-15T20:00:00Z')))).toBe('2026-01-16T18:29:59.999Z');
  });
  it('month and year ends roll over', () => {
    expect(iso(endOfLocalDay('UTC', new Date('2026-12-31T10:00:00Z')))).toBe('2026-12-31T23:59:59.999Z');
  });
});

describe('dueNotAfter', () => {
  it('walkthrough: course ends Fri 16 Jan 23:59 Zurich, clamp to the end of Thursday', () => {
    expect(iso(dueNotAfter(Z, new Date('2026-01-16T22:59:00Z')))).toBe('2026-01-15T22:59:59.999Z');
  });
  it('ends_at at local midnight still gives the day before', () => {
    expect(iso(dueNotAfter(Z, new Date('2026-01-15T23:00:00Z')))).toBe('2026-01-15T22:59:59.999Z');
  });
  it('is not "ends_at minus 24 h" across DST', () => {
    expect(iso(dueNotAfter(Z, new Date('2026-03-30T10:00:00Z')))).toBe('2026-03-29T21:59:59.999Z');
    expect(iso(dueNotAfter(Z, new Date('2026-10-26T10:00:00Z')))).toBe('2026-10-25T22:59:59.999Z');
  });
  it('a zone whose day differs from UTC', () => {
    // 2026-01-16T20:00Z is already 17 Jan in Auckland, so the day before is 16 Jan (ends 10:59:59.999Z)
    expect(iso(dueNotAfter('Pacific/Auckland', new Date('2026-01-16T20:00:00Z')))).toBe('2026-01-16T10:59:59.999Z');
  });
});

describe('isValidTimezone', () => {
  it('accepts IANA names and rejects garbage', () => {
    expect(isValidTimezone(Z)).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
});
