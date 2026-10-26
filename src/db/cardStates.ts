import { and, eq, inArray, isNull } from 'drizzle-orm';
import { newCardState, type CardState } from '../domain/calculator.js';
import type { DbOrTx } from './client.js';
import { columnsToCardState, cardStateToColumns } from './mappers.js';
import { cardStates } from './schema.js';

export type CardStateRecord = {
  userId: string;
  flashcardId: string;
  state: CardState;
  introducedAt: Date;
  sentAt: Date | null;
  remindedAt: Date | null;
  reminderCount: number;
  messageChannel: string | null;
  messageTs: string | null;
};

const toColumns = (r: CardStateRecord): typeof cardStates.$inferInsert => ({
  userId: r.userId,
  flashcardId: r.flashcardId,
  ...cardStateToColumns(r.state),
  introducedAt: r.introducedAt,
  sentAt: r.sentAt,
  remindedAt: r.remindedAt,
  reminderCount: r.reminderCount,
  messageChannel: r.messageChannel,
  messageTs: r.messageTs,
});

export async function getCardState(db: DbOrTx, userId: string, flashcardId: string): Promise<CardStateRecord | null> {
  const [row] = await db
    .select()
    .from(cardStates)
    .where(and(eq(cardStates.userId, userId), eq(cardStates.flashcardId, flashcardId)));
  if (!row) return null;
  return {
    userId: row.userId,
    flashcardId: row.flashcardId,
    state: columnsToCardState(row),
    introducedAt: row.introducedAt,
    sentAt: row.sentAt,
    remindedAt: row.remindedAt,
    reminderCount: row.reminderCount,
    messageChannel: row.messageChannel,
    messageTs: row.messageTs,
  };
}

export async function upsertCardState(db: DbOrTx, record: CardStateRecord): Promise<void> {
  const { userId: _u, flashcardId: _f, ...update } = toColumns(record);
  await db
    .insert(cardStates)
    .values(toColumns(record))
    .onConflictDoUpdate({ target: [cardStates.userId, cardStates.flashcardId], set: update });
}

/** Sets `learned_at` on the given cards that are not learned yet (a learned card keeps its date). */
export async function markLearned(db: DbOrTx, userId: string, flashcardIds: string[], at: Date): Promise<void> {
  if (flashcardIds.length === 0) return;
  await db
    .update(cardStates)
    .set({ learnedAt: at })
    .where(and(eq(cardStates.userId, userId), inArray(cardStates.flashcardId, flashcardIds), isNull(cardStates.learnedAt)));
}

/**
 * Opens the card for a delivery: one statement, so two callers cannot both win (scheduler.md "Idempotent send").
 * A card without a row gets one (`newCardState`, `introduced_at = now`); a card with a row is claimed only while `sent_at` is null.
 * Returns false when the card was already open.
 */
export async function claimCard(db: DbOrTx, userId: string, flashcardId: string, now: Date): Promise<boolean> {
  const rows = await db
    .insert(cardStates)
    .values({ userId, flashcardId, ...cardStateToColumns(newCardState(now)), introducedAt: now, sentAt: now })
    .onConflictDoUpdate({ target: [cardStates.userId, cardStates.flashcardId], set: { sentAt: now, messageChannel: null, messageTs: null }, setWhere: isNull(cardStates.sentAt) })
    .returning({ flashcardId: cardStates.flashcardId });
  return rows.length > 0;
}

/** With `sentAt` the message is recorded only while that delivery is still open (a re-post that raced an answer must not mark a closed card). */
export async function setCardMessage(db: DbOrTx, userId: string, flashcardId: string, channel: string, ts: string, sentAt?: Date): Promise<void> {
  await db
    .update(cardStates)
    .set({ messageChannel: channel, messageTs: ts })
    .where(and(eq(cardStates.userId, userId), eq(cardStates.flashcardId, flashcardId), sentAt ? eq(cardStates.sentAt, sentAt) : undefined));
}

/** Removal (decision 0017): the open card is voided so a restore does not leave a dead message. Progress is untouched. */
export async function voidOpenCard(db: DbOrTx, userId: string, flashcardId: string): Promise<void> {
  await db
    .update(cardStates)
    .set({ sentAt: null, messageTs: null, remindedAt: null, reminderCount: 0 })
    .where(and(eq(cardStates.userId, userId), eq(cardStates.flashcardId, flashcardId)));
}
