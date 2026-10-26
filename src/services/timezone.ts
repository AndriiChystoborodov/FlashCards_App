import { isValidTimezone } from '../domain/localDay.js';

/** The student's `users.tz`, or the tenant timezone when it is null; an invalid value falls back with a warning (decision 0025, choice 11). */
export function studentTimezone(user: { id: string; tz: string | null } | null, tenantTimezone: string, userId = user?.id ?? ''): string {
  const tz = user?.tz ?? tenantTimezone;
  if (isValidTimezone(tz)) return tz;
  console.warn(`invalid timezone ${JSON.stringify(tz)} for user ${userId}, using ${tenantTimezone}`);
  return tenantTimezone;
}
