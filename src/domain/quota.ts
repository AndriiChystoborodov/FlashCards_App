/**
 * How many new (non-assessment) cards a student gets today in total (decision 0006). `introducedToday` is added back so the
 * quota stays the same all day while cards are introduced; the caller subtracts it to get what may still be introduced.
 */
export function quotaToday(remainingNew: number, introducedToday: number, remainingDays: number): number {
  return Math.ceil((remainingNew + introducedToday) / Math.max(1, remainingDays));
}
