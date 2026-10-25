import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { newCardState, type CardState } from '../domain/calculator.js';
import { getCardState, upsertCardState, type CardStateRecord } from './cardStates.js';
import { db, pool, seedCourse } from './testDb.js';
import { cardStates } from './schema.js';

afterAll(() => pool.end());

const now = new Date('2026-01-05T10:00:00Z');
const record = (userId: string, flashcardId: string, state: CardState): CardStateRecord => ({
  userId,
  flashcardId,
  state,
  introducedAt: now,
  sentAt: now,
  remindedAt: null,
  reminderCount: 0,
  messageChannel: 'D1',
  messageTs: '1.2',
});

describe('cardStates repository round trip', () => {
  it('D1: a new card with last_review undefined comes back undefined (NULL in the table)', async () => {
    const { studentId, cardId } = await seedCourse();
    await upsertCardState(db, record(studentId, cardId, newCardState(now)));
    const got = await getCardState(db, studentId, cardId);
    expect(got?.state).toEqual(newCardState(now));
    expect(got?.state.last_review).toBeUndefined();
    const [raw] = await db.select().from(cardStates).where(eq(cardStates.userId, studentId));
    expect(raw?.lastReview).toBeNull();
  });

  it('D2/D3: last_review and learnedAt as dates (incl. fractional stability) round-trip', async () => {
    const { studentId, cardId } = await seedCourse();
    const state: CardState = {
      ...newCardState(now),
      stability: 2.3065,
      difficulty: 2.118,
      reps: 2,
      last_review: new Date('2026-01-04T09:15:30.123Z'),
      learnedAt: now,
      correctStreak: 2,
    };
    await upsertCardState(db, record(studentId, cardId, state));
    expect((await getCardState(db, studentId, cardId))?.state).toEqual(state);
  });

  it.each([0, 1, 2, 3])('D4: ts-fsrs state %i round-trips', async (s) => {
    const { studentId, cardId } = await seedCourse();
    const state = { ...newCardState(now), state: s } as CardState;
    await upsertCardState(db, record(studentId, cardId, state));
    expect((await getCardState(db, studentId, cardId))?.state.state).toBe(s);
  });

  it('D6: a learned card with streak 0 keeps learnedAt (C9 shape)', async () => {
    const { studentId, cardId } = await seedCourse();
    const state = { ...newCardState(now), correctStreak: 0, learnedAt: now };
    await upsertCardState(db, record(studentId, cardId, state));
    expect((await getCardState(db, studentId, cardId))?.state).toEqual(state);
  });

  it('upsert updates an existing row; missing row gives null', async () => {
    const { studentId, cardId } = await seedCourse();
    expect(await getCardState(db, studentId, cardId)).toBeNull();
    await upsertCardState(db, record(studentId, cardId, newCardState(now)));
    await upsertCardState(db, { ...record(studentId, cardId, { ...newCardState(now), reps: 5 }), sentAt: null });
    const got = await getCardState(db, studentId, cardId);
    expect(got?.state.reps).toBe(5);
    expect(got?.sentAt).toBeNull();
  });

  it('works inside a transaction handle and rolls back with it', async () => {
    const { studentId, cardId } = await seedCourse();
    await expect(
      db.transaction(async (tx) => {
        await upsertCardState(tx, record(studentId, cardId, newCardState(now)));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await getCardState(db, studentId, cardId)).toBeNull();
  });
});
