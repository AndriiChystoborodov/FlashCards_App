import { eq } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { users } from './schema.js';

export async function getUser(db: DbOrTx, id: string) {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row ?? null;
}
