/** The only source of time for services, the scheduler and the tick (scheduler.md, Clock). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

const DAY_MS = 24 * 60 * 60 * 1000;

/** A clock the scenario script controls. */
export interface ControlledClock extends Clock {
  set(date: Date): void;
  advanceDays(days: number): void;
}

export function createControlledClock(start: Date): ControlledClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    set: (date) => {
      current = date.getTime();
    },
    advanceDays: (days) => {
      current += days * DAY_MS;
    },
  };
}
