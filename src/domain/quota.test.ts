import { describe, expect, it } from 'vitest';
import { quotaToday } from './quota.js';

describe('quotaToday', () => {
  it('S24: (7 remaining, 12 days) 1, (7, 1 day) 7, (0, 5 days) 0', () => {
    expect(quotaToday(7, 0, 12)).toBe(1);
    expect(quotaToday(7, 0, 1)).toBe(7);
    expect(quotaToday(0, 0, 5)).toBe(0);
  });

  it('S25: the quota stays the same while cards are introduced during the day', () => {
    const before = quotaToday(7, 0, 3);
    expect(quotaToday(6, 1, 3)).toBe(before);
    expect(quotaToday(5, 2, 3)).toBe(before);
  });

  it('S26: after two skipped days the quota rises, the course still ends on time', () => {
    expect(quotaToday(7, 0, 7)).toBe(1); // on schedule
    expect(quotaToday(7, 0, 5)).toBe(2); // two days later, nothing introduced in between
  });

  it('S27: a card added mid-course raises the quota; remainingDays below 1 counts as 1', () => {
    expect(quotaToday(4, 0, 4)).toBe(1);
    expect(quotaToday(5, 0, 4)).toBe(2);
    expect(quotaToday(3, 0, 0)).toBe(3);
  });
});
