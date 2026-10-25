import { describe, expect, it } from 'vitest';
import { newCardState } from '../domain/calculator.js';
import { cardStateToColumns, columnsToCardState } from './mappers.js';
import type { cardStates } from './schema.js';

const now = new Date('2026-01-05T10:00:00Z');
const asRow = (cols: ReturnType<typeof cardStateToColumns>): typeof cardStates.$inferSelect => ({
  userId: 'u',
  flashcardId: 'f',
  ...cols,
  introducedAt: now,
  sentAt: null,
  remindedAt: null,
  reminderCount: 0,
  messageChannel: null,
  messageTs: null,
});

describe('card state mapper', () => {
  it('D1: last_review undefined becomes null and back', () => {
    const state = newCardState(now);
    expect(state.last_review).toBeUndefined();
    const cols = cardStateToColumns(state);
    expect(cols.lastReview).toBeNull();
    expect(columnsToCardState(asRow(cols))).toEqual(state);
    expect(columnsToCardState(asRow(cols)).last_review).toBeUndefined();
  });

  it('D2/D3: dates and learnedAt survive', () => {
    const state = { ...newCardState(now), last_review: now, learnedAt: now, correctStreak: 2 };
    expect(columnsToCardState(asRow(cardStateToColumns(state)))).toEqual(state);
  });
});
