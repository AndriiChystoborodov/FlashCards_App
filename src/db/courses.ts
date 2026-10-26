import { eq } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { courses } from './schema.js';

export async function getCourse(db: DbOrTx, id: string) {
  const [row] = await db.select().from(courses).where(eq(courses.id, id));
  return row ?? null;
}
