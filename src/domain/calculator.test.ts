import { Rating, type FSRS } from 'ts-fsrs';
import { describe, expect, it, vi } from 'vitest';
import { applyAnswer, MissingRatingError, newCardState, type CardState, type Rating3 } from './calculator.js';

const CARD = { correctOption: 1 };
const DAY = 86_400_000;
const T0 = new Date('2026-01-05T14:06:00Z');
const at = (days: number, ms = 0) => new Date(T0.getTime() + days * DAY + ms);
const right = (rating: Rating3 | undefined) => ({ chosenOption: 1, rating });
const WRONG = { chosenOption: 0 };

/** Answers each step at the given day offset from T0; returns every state. */
function run(steps: [number, Parameters<typeof applyAnswer>[2]][]): CardState[] {
  let state = newCardState(T0);
  return steps.map(([day, answer]) => (state = applyAnswer(CARD, state, answer, at(day)).state));
}

describe('grades and streak', () => {
  it('C1 right + medium', () => {
    const { state, review } = applyAnswer(CARD, newCardState(T0), right('medium'), T0);
    expect(state.correctStreak).toBe(1);
    expect(state.learnedAt).toBeNull();
    expect(state.scheduled_days).toBe(2);
    expect(review).toEqual({ chosenOption: 1, isCorrect: true, rating: 'medium', reviewedAt: T0 });
  });
  it('C2 right + easy', () => {
    const { state } = applyAnswer(CARD, newCardState(T0), right('easy'), T0);
    expect(state.correctStreak).toBe(1);
    expect(state.scheduled_days).toBe(8);
  });
  it('C3 right + hard', () => {
    const { state } = applyAnswer(CARD, newCardState(T0), right('hard'), T0);
    expect(state.correctStreak).toBe(0);
    expect(state.scheduled_days).toBe(1);
  });
  it('C4 wrong option', () => {
    const { state, review } = applyAnswer(CARD, newCardState(T0), WRONG, T0);
    expect(state.correctStreak).toBe(0);
    expect(state.scheduled_days).toBe(1);
    expect(review).toMatchObject({ isCorrect: false, rating: null });
  });
  it('C5 Don\'t know', () => {
    const { state, review } = applyAnswer(CARD, newCardState(T0), { chosenOption: null }, T0);
    expect(state.correctStreak).toBe(0);
    expect(review).toMatchObject({ chosenOption: null, isCorrect: false, rating: null });
  });
  it('C7 medium, hard, medium', () => {
    const s = run([[0, right('medium')], [2, right('hard')], [3, right('medium')]]);
    expect(s.map((x) => x.correctStreak)).toEqual([1, 0, 1]);
    expect(s[2]!.learnedAt).toBeNull();
  });
  it('C8 easy, wrong, medium', () => {
    const s = run([[0, right('easy')], [8, WRONG], [9, right('medium')]]);
    expect(s.map((x) => x.correctStreak)).toEqual([1, 0, 1]);
  });
});

describe('learned and the retention gap', () => {
  it('C6 medium, medium 8 days later', () => {
    const s = run([[0, right('medium')], [8, right('medium')]]);
    expect(s[1]!.correctStreak).toBe(2);
    expect(s[1]!.learnedAt).toEqual(at(8));
  });
  it('C18 medium, medium 2 days later', () => {
    const s = run([[0, right('medium')], [2, right('medium')]]);
    expect(s[1]!.correctStreak).toBe(2);
    expect(s[1]!.learnedAt).toBeNull();
  });
  it('C19 gap exactly 7 days', () => {
    const s = run([[0, right('medium')], [7, right('medium')]]);
    expect(s[1]!.learnedAt).toEqual(at(7));
  });
  it('C20 gap just under 7 days', () => {
    const state = run([[0, right('medium')]])[0]!;
    const now = at(7, -60_000);
    expect(applyAnswer(CARD, state, right('medium'), now).state.learnedAt).toBeNull();
  });
  it('C21 short gap, then a third answer after 7+ days', () => {
    const s = run([[0, right('medium')], [2, right('medium')], [10, right('medium')]]);
    expect(s[1]!.learnedAt).toBeNull();
    expect(s[2]!.correctStreak).toBe(3);
    expect(s[2]!.learnedAt).toEqual(at(10));
  });
  it('C22 streak 2, long gap, but hard', () => {
    const s = run([[0, right('medium')], [2, right('medium')], [10, right('hard')]]);
    expect(s[2]!.correctStreak).toBe(0);
    expect(s[2]!.learnedAt).toBeNull();
  });
  it('C23 first answer has no last_review', () => {
    const state = { ...newCardState(T0), correctStreak: 5 };
    expect(state.last_review).toBeUndefined();
    expect(applyAnswer(CARD, state, right('easy'), at(30)).state.learnedAt).toBeNull();
  });
  it('C9 learned, then wrong: streak 0, learnedAt kept', () => {
    const s = run([[0, right('medium')], [8, right('medium')], [20, WRONG]]);
    expect(s[2]!.correctStreak).toBe(0);
    expect(s[2]!.learnedAt).toEqual(at(8));
  });
  it('learnedAt kept after a later right answer', () => {
    const s = run([[0, right('medium')], [8, right('medium')], [30, right('easy')]]);
    expect(s[2]!.learnedAt).toEqual(at(8));
  });
});

describe('ratings and purity', () => {
  it('C10 right without rating throws', () => {
    expect(() => applyAnswer(CARD, newCardState(T0), right(undefined), T0)).toThrow(MissingRatingError);
    expect(() => applyAnswer(CARD, newCardState(T0), right(undefined), T0)).toThrow(
      'A right answer needs a rating (hard, medium or easy)',
    );
  });
  it('C11 wrong with a rating: rating ignored', () => {
    const { review } = applyAnswer(CARD, newCardState(T0), { chosenOption: 0, rating: 'easy' }, T0);
    expect(review.rating).toBeNull();
  });
  it('rating on Don\'t know is ignored', () => {
    const { review, state } = applyAnswer(CARD, newCardState(T0), { chosenOption: null, rating: 'easy' }, T0);
    expect(review.rating).toBeNull();
    expect(state.correctStreak).toBe(0);
  });
  it('C12 input state is not mutated', () => {
    const state = newCardState(T0);
    const copy = structuredClone(state);
    applyAnswer(CARD, state, right('medium'), T0);
    expect(state).toEqual(copy);
  });
  it('C13 same input, same output', () => {
    const state = newCardState(T0);
    expect(applyAnswer(CARD, state, right('medium'), T0)).toEqual(applyAnswer(CARD, state, right('medium'), T0));
  });
  it('late answer: due is recomputed from the actual answer time', () => {
    const state = run([[0, right('medium')]])[0]!;
    const late = applyAnswer(CARD, state, right('medium'), at(5)).state;
    expect(late.last_review).toEqual(at(5));
    expect(late.due.getTime()).toBeGreaterThan(at(5).getTime());
  });
});

describe('FSRS delegation', () => {
  it('C14 due comes from scheduler.next', () => {
    const state = newCardState(T0);
    const scheduler = { next: vi.fn().mockReturnValue({ card: { ...state, due: at(42) } }) } as unknown as FSRS;
    const out = applyAnswer(CARD, state, right('easy'), T0, scheduler);
    expect(out.state.due).toEqual(at(42));
  });
  it('C17 custom scheduler is used once with the mapped grade', () => {
    const state = newCardState(T0);
    const next = vi.fn().mockReturnValue({ card: state });
    applyAnswer(CARD, state, right('medium'), T0, { next } as unknown as FSRS);
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(state, T0, Rating.Good);
  });
  it('C15 numbers from the walkthrough', () => {
    const sd = (steps: [number, Parameters<typeof applyAnswer>[2]][]) => run(steps).map((x) => x.scheduled_days);
    // answered at due time, one send per interval
    expect(sd([[0, right('medium')], [2, right('medium')]])).toEqual([2, 11]);
    expect(sd([[0, right('easy')], [8, right('easy')]])).toEqual([8, 66]);
    expect(sd([[0, WRONG]])).toEqual([1]);
    expect(sd([[0, right('medium')], [2, WRONG]])).toEqual([2, 1]);
    // each answer at the previous card's due time (Hard's first due is 1.5 days, not 1)
    let hhg = newCardState(T0);
    let now = T0;
    const hhgDays = (['hard', 'hard', 'medium'] as const).map((r) => {
      hhg = applyAnswer(CARD, hhg, right(r), now).state;
      now = hhg.due;
      return hhg.scheduled_days;
    });
    expect(hhgDays).toEqual([1, 4, 12]);
    const gg = run([[0, right('medium')], [2, right('medium')]]);
    expect(gg.map((x) => +x.stability.toFixed(2))).toEqual([2.31, 10.96]);
    expect(+run([[0, WRONG]])[0]!.stability.toFixed(2)).toBe(0.21);
  });
  it('C16 newCardState', () => {
    const s = newCardState(T0);
    expect(s).toMatchObject({ state: 0, correctStreak: 0, learnedAt: null, due: T0 });
    expect(s.last_review).toBeUndefined();
  });
});
