import { describe, expect, it } from 'vitest';
import { dueNotAfter, endOfLocalDay, isValidTimezone, localDaysThrough, localHour, startOfLocalDayOf } from './localDay.js';

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

describe('startOfLocalDayOf and localDaysThrough', () => {
  it('startOfLocalDayOf is the first millisecond of the local day, across DST', () => {
    expect(startOfLocalDayOf('Europe/Zurich', new Date('2026-01-05T09:00:00Z'))).toEqual(new Date('2026-01-04T23:00:00Z'));
    expect(startOfLocalDayOf('Europe/Zurich', new Date('2026-03-29T10:00:00Z'))).toEqual(new Date('2026-03-28T23:00:00Z'));
    expect(startOfLocalDayOf('America/Los_Angeles', new Date('2026-01-16T03:00:00Z'))).toEqual(new Date('2026-01-15T08:00:00Z'));
  });

  it('counts local days inclusive: walkthrough Monday 5 January to Friday 16 January is 12', () => {
    expect(localDaysThrough('Europe/Zurich', new Date('2026-01-05T13:06:00Z'), new Date('2026-01-16T22:59:00Z'))).toBe(12);
  });

  it('the local day, not UTC, decides: 23:30 Zurich on the 5th and 00:30 on the 6th are two days apart by one', () => {
    expect(localDaysThrough('Europe/Zurich', new Date('2026-01-05T22:30:00Z'), new Date('2026-01-05T23:30:00Z'))).toBe(2);
  });

  it('is at least 1, also when ends_at is already past (S27)', () => {
    expect(localDaysThrough('UTC', new Date('2026-01-10T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))).toBe(1);
  });

  it('counts a DST change day as one day', () => {
    expect(localDaysThrough('Europe/Zurich', new Date('2026-03-28T10:00:00Z'), new Date('2026-03-30T10:00:00Z'))).toBe(3);
  });
});

describe('localHour', () => {
  const h = (tz: string, iso: string) => localHour(tz, new Date(iso));
  it('Zurich: 09:00 local is 08:00Z in winter and 07:00Z in summer', () => {
    expect(h(Z, '2026-01-06T08:00:00Z')).toBe(9);
    expect(h(Z, '2026-01-06T07:59:00Z')).toBe(8);
    expect(h(Z, '2026-07-01T07:00:00Z')).toBe(9);
  });
  it('Zurich spring forward 2026-03-29 and fall back 2026-10-25', () => {
    expect(h(Z, '2026-03-29T00:59:00Z')).toBe(1);
    expect(h(Z, '2026-03-29T01:00:00Z')).toBe(3); // 02:00 does not exist
    expect(h(Z, '2026-03-29T06:59:00Z')).toBe(8);
    expect(h(Z, '2026-03-29T07:00:00Z')).toBe(9);
    expect(h(Z, '2026-10-25T00:30:00Z')).toBe(2);
    expect(h(Z, '2026-10-25T01:30:00Z')).toBe(2); // 02:30 happens twice
    expect(h(Z, '2026-10-25T07:59:00Z')).toBe(8);
    expect(h(Z, '2026-10-25T08:00:00Z')).toBe(9);
  });
  it('Asia/Kolkata has a half-hour offset: 09:00 local is 03:30Z', () => {
    expect(h('Asia/Kolkata', '2026-01-06T03:29:00Z')).toBe(8);
    expect(h('Asia/Kolkata', '2026-01-06T03:30:00Z')).toBe(9);
    expect(h('Asia/Kolkata', '2026-07-06T03:30:00Z')).toBe(9); // no DST
  });
  it('America/New_York: spring forward 2026-03-08 and fall back 2026-11-01 (US dates, not Europe\'s)', () => {
    expect(h('America/New_York', '2026-03-08T06:59:00Z')).toBe(1); // EST
    expect(h('America/New_York', '2026-03-08T07:00:00Z')).toBe(3); // 02:00 EST jumps to 03:00 EDT
    expect(h('America/New_York', '2026-03-08T13:00:00Z')).toBe(9); // EDT, 09:00 is 13:00Z
    expect(h('America/New_York', '2026-03-29T12:59:00Z')).toBe(8); // Zurich's date: New York is already on EDT
    expect(h('America/New_York', '2026-11-01T05:30:00Z')).toBe(1); // EDT
    expect(h('America/New_York', '2026-11-01T06:30:00Z')).toBe(1); // 01:30 happens twice
    expect(h('America/New_York', '2026-11-01T13:59:00Z')).toBe(8); // EST, 09:00 is 14:00Z
    expect(h('America/New_York', '2026-11-01T14:00:00Z')).toBe(9);
  });
  it('the hour is 0 to 23 (never 24) at midnight', () => {
    expect(h(Z, '2026-01-05T23:00:00Z')).toBe(0);
    expect(h('UTC', '2026-01-05T00:00:00Z')).toBe(0);
  });
});
