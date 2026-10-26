import { listTickTargets } from '../db/enrollments.js';
import { getOpenCard } from '../db/selection.js';
import { getUser } from '../db/users.js';
import { localHour } from '../domain/localDay.js';
import { finishEndedCourses, resendStaleClaim, sendNext, type SchedulerDeps } from './scheduler.js';
import { studentTimezone } from './timezone.js';

export interface TickConfig {
  /** Local hour from which the tick starts a student's day (`SEND_HOUR`). */
  sendHour: number;
  /** A claim without a recorded post older than this is posted again (scheduler.md "Idempotent send"). */
  staleClaimMinutes?: number;
  /** Limits the pass to these courses. Tests use it so a pass does not touch other tests' courses in the shared database. */
  courseIds?: string[];
}

export const STALE_CLAIM_MINUTES = 10;

export interface TickSummary {
  sent: number;
  resent: number;
  failed: number;
}

/**
 * One pass of the daily tick (scheduler.md "Tick"): finish the courses that reached `ends_at`, then for each present active
 * enrollment either re-post a stale claim (at any hour: the send was already started) or, when the student's local hour is at
 * least `sendHour` and no card is open, call `sendNext`. Students are handled one after another; a failure is logged and skipped.
 * Repeating it sends nothing new: `next()` is empty once the day's work is done.
 */
export async function runTick(deps: SchedulerDeps, cfg: TickConfig): Promise<TickSummary> {
  const summary: TickSummary = { sent: 0, resent: 0, failed: 0 };
  const now = deps.clock.now();
  const staleMs = (cfg.staleClaimMinutes ?? STALE_CLAIM_MINUTES) * 60_000;
  try {
    await finishEndedCourses(deps, cfg.courseIds);
  } catch (err) {
    summary.failed += 1;
    console.error('finishing ended courses failed', err);
  }
  for (const { userId, courseId } of await listTickTargets(deps.db, cfg.courseIds)) {
    try {
      const open = await getOpenCard(deps.db, userId, courseId);
      if (open) {
        if (await resendStaleClaim(deps, userId, courseId, staleMs, open)) summary.resent += 1;
        continue;
      }
      const tz = studentTimezone(await getUser(deps.db, userId), deps.tenantTimezone);
      if (localHour(tz, now) < cfg.sendHour) continue;
      if ((await sendNext(deps, userId, courseId)).status === 'sent') summary.sent += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(`tick failed for user ${userId} in course ${courseId}`, err);
    }
  }
  return summary;
}

export interface TickHandle {
  /** Stops further passes; resolves when a pass that is already running has finished. */
  stop(): Promise<void>;
  /** Passes started and passes skipped because the previous one was still running. */
  stats: { runs: number; skipped: number };
}

/**
 * Runs `runTick` every `intervalMs` (`TICK_MINUTES`). A pass that is still running when the next interval fires makes that
 * interval skip, so passes never overlap. The first pass is one interval after the start. Task 8 calls this from `src/index.ts`
 * with the real Slack adapter; until then only tests and the scenario use `runTick`.
 */
export function startTick(deps: SchedulerDeps, cfg: TickConfig & { intervalMs: number }): TickHandle {
  const stats = { runs: 0, skipped: 0 };
  let running = false;
  let inflight: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    if (running) {
      stats.skipped += 1;
      return;
    }
    running = true;
    stats.runs += 1;
    inflight = runTick(deps, cfg)
      .catch((err) => console.error('tick failed', err))
      .finally(() => {
        running = false;
      });
  }, cfg.intervalMs);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await inflight;
    },
    stats,
  };
}
