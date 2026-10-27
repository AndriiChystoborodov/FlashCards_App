import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';
import type { Clock } from '../clock.js';
import { ERROR_TEXT, REJECT_TEXT, type CardMessage } from '../slack/card.js';
import type { ActionRouter, ClickArgs } from '../slack/handlers.js';
import type { SlackPort } from '../slack/port.js';
import { createRedactor, type Redactor } from './redact.js';
import { traceSchema, type Trace, type TraceEvent } from './schema.js';

/** The header the scenario's own clients set so the server-side middleware can name the caller. Recorder-only: without a recorder nothing reads it (a test proves it). */
export const CALLER_HEADER = 'x-trace-caller';
const VALID_CALLER = /^[A-Za-z0-9:_.-]{1,60}$/;

/** Who caused what happens next: `origin` is the entry point (rest, tick, click, service, scenario), `caller` names it more closely. */
export interface Context {
  origin: string;
  caller: string;
}
const UNATTRIBUTED: Context = { origin: 'unattributed', caller: 'unattributed' };

export interface Recorder {
  readonly redactor: Redactor;
  /** Runs `fn` with `ctx` as the cause of every Slack call and event inside it. */
  run<T>(ctx: Context, fn: () => T): T;
  /** `run` plus an `entry` event (the services entered in-process: the tick, a student answer). `detail` summarises the result. */
  within<T>(ctx: Context, label: string, fn: () => Promise<T>, detail?: (r: T) => unknown): Promise<T>;
  /** Express middleware for `ApiDeps.recorder`: records every request when the response finishes. */
  middleware(): RequestHandler;
  /** A `SlackPort` that records every call and forwards it. */
  slack(port: SlackPort): SlackPort;
  /** An `ActionRouter` that records every handler run and forwards. */
  router(router: ActionRouter): ActionRouter;
  beginStep(n: number, name: string): void;
  endStep(tableDelta: Record<string, number>): void;
  /** Everything recorded so far, already redacted. */
  trace(meta: Trace['meta']): Trace;
}

type Pending<K extends TraceEvent['kind']> = Extract<TraceEvent, { kind: K }>;

const buttonsOf = (m: { blocks: readonly unknown[] }): string[] =>
  m.blocks.flatMap((b) => {
    const elements = typeof b === 'object' && b !== null && 'elements' in b && Array.isArray(b.elements) ? (b.elements as unknown[]) : [];
    return elements.flatMap((e) => (typeof e === 'object' && e !== null && 'action_id' in e && typeof e.action_id === 'string' ? [e.action_id] : []));
  });

/** What the handler showed, as a code. A click that ends without a message (duplicate, malformed) stays `no_response`. */
function outcomeOf(m: { text: string; blocks?: CardMessage['blocks'] }): string {
  if (m.text === ERROR_TEXT) return 'error';
  const reject = Object.entries(REJECT_TEXT).find(([, t]) => t === m.text);
  if (reject) return `rejected:${reject[0]}`;
  if (m.text.startsWith('Not quite')) return 'wrong';
  if (m.blocks && buttonsOf({ blocks: m.blocks }).some((a) => a.startsWith('rate_'))) return 'rating_prompt';
  return 'replaced';
}

export function createRecorder(opts: { clock: Clock }): Recorder {
  const redactor = createRedactor();
  const als = new AsyncLocalStorage<Context>();
  const steps: { n: number; name: string; events: TraceEvent[]; tableDelta: Record<string, number> }[] = [];
  let current: (typeof steps)[number] | null = null;
  let seq = 0;
  const ctx = () => als.getStore() ?? UNATTRIBUTED;
  const stamp = () => opts.clock.now().toISOString();

  const step = () => {
    if (!current) {
      current = { n: 0, name: '(outside any step)', events: [], tableDelta: {} };
      steps.push(current);
    }
    return current;
  };
  /** Takes the event's place in the order now; the caller fills it in when the thing finishes. */
  const reserve = <E extends TraceEvent>(e: E): E => {
    step().events.push(e);
    return e;
  };

  function slack(port: SlackPort): SlackPort {
    const record = async <T>(call: 'postCard' | 'replaceMessage' | 'lookupEmail', req: unknown, fn: () => Promise<T>): Promise<T> => {
      const c = ctx();
      const ev = reserve<Pending<'slack'>>({ seq: (seq += 1), t: stamp(), kind: 'slack', caller: c.caller, origin: c.origin, call, req: redactor.json(req), res: null });
      try {
        const res = await fn();
        ev.res = redactor.json(res);
        return res;
      } catch (err) {
        ev.error = redactor.text(err instanceof Error ? err.name : 'unknown'); // the name only: messages can carry request details
        throw err;
      }
    };
    const msg = (m: CardMessage) => ({ text: m.text, buttons: buttonsOf(m) });
    return {
      // The image is recorded as a placeholder with its size and alt text, never its bytes (decision 0034).
      postCard: (to, m, image) => record('postCard', { to, ...msg(m), ...(image && { image: `<image ${image.width}x${image.height}>`, alt: image.alt }) }, () => port.postCard(to, m, image)),
      replaceMessage: (channel, ts, m) => record('replaceMessage', { channel, ts, ...msg(m) }, () => port.replaceMessage(channel, ts, m)),
      lookupEmail: (email) => record('lookupEmail', { email }, () => port.lookupEmail(email)),
    };
  }

  function router(r: ActionRouter): ActionRouter {
    return {
      action: (pattern, handler) =>
        r.action(pattern, (a: ClickArgs) =>
          als.run({ origin: 'click', caller: 'slack-handler' }, async () => {
            const c = ctx();
            const ev = reserve<Pending<'click'>>({ seq: (seq += 1), t: stamp(), kind: 'click', caller: c.caller, actionId: redactor.text(a.action.action_id), user: redactor.slackId(a.body.user.id), outcome: 'no_response' });
            try {
              await handler({ ...a, respond: (m) => ((ev.outcome = outcomeOf(m)), a.respond(m)) });
            } catch (err) {
              ev.outcome = 'threw';
              throw err;
            }
          }),
        ),
    };
  }

  const middleware = (): RequestHandler => (req, res, next) => {
    const tag = req.get(CALLER_HEADER);
    const caller = tag && VALID_CALLER.test(tag) ? redactor.text(tag) : 'unattributed'; // a tag is a label, but it is client text, so it is scanned like any
    const chunks: Buffer[] = [];
    let size = 0;
    const end = res.end;
    res.end = function (this: typeof res, ...args: Parameters<typeof res.end>) {
      const chunk: unknown = args[0];
      if ((typeof chunk === 'string' || Buffer.isBuffer(chunk)) && size < 200_000) {
        const b = Buffer.from(chunk);
        size += b.length;
        chunks.push(b);
      }
      return end.apply(this, args);
    } as typeof res.end;
    const ev = reserve<Pending<'rest'>>({ seq: (seq += 1), t: stamp(), kind: 'rest', caller, method: req.method, template: null, path: '', status: -1, req: null, res: null });
    res.on('finish', () => {
      try {
        fill();
      } catch {
        ev.res = '[the recorder failed on this response]'; // recording must never take the server down
        ev.status = res.statusCode;
      }
    });
    const fill = () => {
      const route = (req.route as { path?: unknown } | undefined)?.path;
      const template = typeof route === 'string' ? req.baseUrl + route : null;
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const reqBody: unknown = (req as { body?: unknown }).body;
      ev.template = template ? redactor.text(template) : null;
      ev.path = redactor.path(req.originalUrl, template);
      ev.status = res.statusCode;
      ev.req = reqBody === undefined || (typeof reqBody === 'object' && reqBody !== null && Object.keys(reqBody).length === 0) ? null : redactor.json(reqBody);
      ev.res = redactor.json(body);
    };
    als.run({ origin: 'rest', caller }, next);
  };

  return {
    redactor,
    run: (c, fn) => als.run(c, fn),
    async within(c, label, fn, detail) {
      return als.run(c, async () => {
        const ev = reserve<Pending<'entry'>>({ seq: (seq += 1), t: stamp(), kind: 'entry', caller: c.caller, origin: c.origin, label: redactor.text(label) });
        try {
          const r = await fn();
          if (detail) ev.detail = redactor.json(detail(r));
          return r;
        } catch (err) {
          ev.detail = { error: redactor.text(err instanceof Error ? err.name : 'unknown') };
          throw err;
        }
      });
    },
    middleware,
    slack,
    router,
    beginStep(n, name) {
      current = { n, name: redactor.text(name), events: [], tableDelta: {} };
      steps.push(current);
    },
    endStep(tableDelta) {
      if (current) current.tableDelta = tableDelta;
    },
    trace(meta) {
      const out = { version: 1 as const, meta, steps: steps.map((s) => ({ ...s, events: s.events.filter((e) => e.kind !== 'rest' || e.status !== -1) })) };
      return traceSchema.parse(out);
    },
  };
}
