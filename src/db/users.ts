import { eq } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { users } from './schema.js';

export async function getUser(db: DbOrTx, id: string) {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row ?? null;
}

export async function setDmChannel(db: DbOrTx, id: string, channel: string): Promise<void> {
  await db.update(users).set({ slackDmChannel: channel }).where(eq(users.id, id));
}
