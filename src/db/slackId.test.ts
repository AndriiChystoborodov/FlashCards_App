import { afterAll, describe, expect, it } from 'vitest';
import { db, pool } from './testDb.js';
import { users } from './schema.js';
import { findUserBySlackId } from './users.js';

afterAll(() => pool.end());

describe('users.slack_id', () => {
  it('finds a user by Slack id, null for an unknown one, and two users cannot share an id (null may repeat)', async () => {
    const tag = crypto.randomUUID();
    const slackId = `U-${tag}`;
    const [u] = await db.insert(users).values({ fullName: 'A', email: `a-${tag}@x.test`, role: 'student', slackId }).returning();
    expect((await findUserBySlackId(db, slackId))?.id).toBe(u!.id);
    expect(await findUserBySlackId(db, `U-none-${tag}`)).toBeNull();
    await expect(db.insert(users).values({ fullName: 'B', email: `b-${tag}@x.test`, role: 'student', slackId })).rejects.toThrow();
    await db.insert(users).values([{ fullName: 'C', email: `c-${tag}@x.test`, role: 'student' }, { fullName: 'D', email: `d-${tag}@x.test`, role: 'student' }]);
  });
});
