// Local-day bounds from Intl only (no Temporal): the scheduler compares `due` with the end of the
// student's local day, and the answer service clamps `due` to the day before `ends_at`.
const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(tz: string, ms: number): { year: number; month: number; day: number; offsetMs: number } {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  const wallAsUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return { year: p.year!, month: p.month!, day: p.day!, offsetMs: wallAsUtc - Math.floor(ms / 1000) * 1000 };
}

// shortcut: in a zone whose DST gap covers local midnight (America/Sao_Paulo before 2019) the day start is 1 h early; fix if such a zone is ever used.
function startOfLocalDay(tz: string, year: number, month: number, day: number): number {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - localParts(tz, guess).offsetMs;
  return guess - localParts(tz, first).offsetMs;
}

export const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** The last millisecond of the local day containing `date`. A day is 23 or 25 hours across DST. */
export function endOfLocalDay(tz: string, date: Date): Date {
  const p = localParts(tz, date.getTime());
  return new Date(startOfLocalDay(tz, p.year, p.month, p.day + 1) - 1);
}

/** The end of the local day before the local day of `endsAt`: the latest `due` that still gets a review inside the course. */
export function dueNotAfter(tz: string, endsAt: Date): Date {
  const p = localParts(tz, endsAt.getTime());
  return new Date(startOfLocalDay(tz, p.year, p.month, p.day) - 1);
}
