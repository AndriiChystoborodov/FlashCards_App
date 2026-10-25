import { describe, expect, it } from 'vitest';
import { createControlledClock, systemClock } from './clock.js';

describe('clock', () => {
  it('systemClock returns the current time', () => {
    const before = Date.now();
    const t = systemClock.now().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  it('controlled clock stays put until moved', () => {
    const clock = createControlledClock(new Date('2026-01-12T10:00:00Z'));
    expect(clock.now()).toEqual(new Date('2026-01-12T10:00:00Z'));
    expect(clock.now()).toEqual(clock.now());
  });

  it('advanceDays moves forward, also by fractions', () => {
    const clock = createControlledClock(new Date('2026-01-12T10:00:00Z'));
    clock.advanceDays(2);
    clock.advanceDays(0.5);
    expect(clock.now()).toEqual(new Date('2026-01-14T22:00:00Z'));
  });

  it.each([NaN, Infinity, -Infinity])('advanceDays rejects %s and keeps the time', (days) => {
    const clock = createControlledClock(new Date('2026-01-12T10:00:00Z'));
    expect(() => clock.advanceDays(days)).toThrow(RangeError);
    expect(clock.now()).toEqual(new Date('2026-01-12T10:00:00Z'));
  });

  it('set replaces the time, and returned dates are copies', () => {
    const clock = createControlledClock(new Date('2026-01-12T10:00:00Z'));
    clock.set(new Date('2026-02-01T00:00:00Z'));
    clock.now().setFullYear(1999);
    expect(clock.now()).toEqual(new Date('2026-02-01T00:00:00Z'));
  });
});
