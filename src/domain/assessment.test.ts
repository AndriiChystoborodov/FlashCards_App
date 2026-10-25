import { describe, expect, it } from 'vitest';
import { evaluateAssessment } from './assessment.js';

const easy = { isCorrect: true, rating: 'easy' as const };
const medium = { isCorrect: true, rating: 'medium' as const };
const hard = { isCorrect: true, rating: 'hard' as const };
const wrong = { isCorrect: false, rating: null };
const many = (n: number, r: typeof easy | typeof wrong, rest: typeof easy | typeof wrong = wrong, total = 10) =>
  Array.from({ length: total }, (_, i) => (i < n ? r : rest));

describe('evaluateAssessment', () => {
  it('A1 all easy', () => expect(evaluateAssessment(many(10, easy), 90)).toMatchObject({ score: 100, exempt: true }));
  it('A2 9 of 10 is exempt at 90 (inclusive)', () =>
    expect(evaluateAssessment(many(9, easy), 90)).toMatchObject({ score: 90, exempt: true }));
  it('A3 8 of 10 is not exempt', () => expect(evaluateAssessment(many(8, easy), 90).exempt).toBe(false));
  it('A4 all medium', () =>
    expect(evaluateAssessment(Array(10).fill(medium), 90)).toMatchObject({ score: 0, exempt: false }));
  it('A5 hard is not passed', () => expect(evaluateAssessment([hard], 90).passedFlags).toEqual([false]));
  it('A6 wrong or null is not passed', () =>
    expect(evaluateAssessment([wrong, { isCorrect: false, rating: null }], 90).passedFlags).toEqual([false, false]));
  it('A7 threshold 100 with one failure', () => expect(evaluateAssessment(many(9, easy), 100).exempt).toBe(false));
  it('A8 zero cards', () =>
    expect(evaluateAssessment([], 90)).toEqual({ passedFlags: [], score: null, exempt: false }));
  it('A9 flags keep input order', () =>
    expect(evaluateAssessment([easy, wrong, medium, easy], 90).passedFlags).toEqual([true, false, false, true]));
});
