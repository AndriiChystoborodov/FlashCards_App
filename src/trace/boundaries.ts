import type { TraceEvent } from './schema.js';

/** Arrows that become a network hop in a cloud deployment (decision 0032). A fixed function of who talks to whom, not of the data. */
export interface Boundary {
  id: 'B1' | 'B2' | 'B3' | 'B4';
  name: string;
  arrow: string;
  /** What in the current code would have to change; one line, no plan. */
  change: string;
  docs: { label: string; href: string }[];
}

export const BOUNDARIES: Boundary[] = [
  {
    id: 'B1',
    name: 'Database connection',
    arrow: 'Services to Postgres (drawn once per step that changed rows)',
    change: 'Every process builds its own pool with createDb(DATABASE_URL) (src/db/client.ts; src/index.ts, scripts); a hosted database needs a pooled TLS URL, a migration job, and one pool per process once the tick is split off.',
    docs: [{ label: 'decision 0010', href: '../docs/decisions/0010-database-postgres-supabase.md' }, { label: 'decision 0023', href: '../docs/decisions/0023-local-first.md' }],
  },
  {
    id: 'B2',
    name: 'Slack in HTTP mode',
    arrow: 'Slack to the action handlers (a click)',
    change: 'src/index.ts refuses SLACK_MODE=http and src/slack/start.ts builds a socket-mode App; HTTP mode needs the signing secret, a public route on the Express app, and the 3-second ack budget on a request instead of a socket.',
    docs: [{ label: 'decision 0002', href: '../docs/decisions/0002-slack-socket-mode-dev-http-prod.md' }, { label: 'integration.md', href: '../docs/slack/integration.md' }],
  },
  {
    id: 'B3',
    name: 'Tick as a separate worker',
    arrow: 'Tick to Services',
    change: 'startTick(deps, ...) runs inside the web process (src/index.ts); a worker needs its own entry point, database pool and Slack port, and the claim in the database (decision 0027) must be the only guard against two ticks overlapping.',
    docs: [{ label: 'decision 0027', href: '../docs/decisions/0027-task6b1-tick-choices.md' }, { label: 'scheduler.md', href: '../docs/scheduler.md' }],
  },
  {
    id: 'B4',
    name: 'Remote MCP',
    arrow: 'MCP client to the REST API',
    change: 'src/mcp/index.ts is a stdio server with one RETAIN_API_TOKEN from the environment; remote means an HTTP transport and a token per teacher. The REST client already takes a base URL and a token.',
    docs: [{ label: 'decision 0007', href: '../docs/decisions/0007-mcp-stdio-thin-client.md' }, { label: 'decision 0031', href: '../docs/decisions/0031-task9-mcp-choices.md' }],
  },
];

/** The boundary an event crosses, if any. Slack Web API calls are already network today, so they carry none. */
export function boundaryOf(e: TraceEvent): Boundary['id'] | null {
  if (e.kind === 'rest' && e.caller.startsWith('mcp:')) return 'B4';
  if (e.kind === 'click') return 'B2';
  if (e.kind === 'entry' && e.origin === 'tick') return 'B3';
  return null;
}

/** Shown beside the swimlanes and in the legend: the handlers and the tick do not use REST. */
export const DIRECT_CALL_NOTE =
  'Slack handlers and the tick call the services directly, in the same process. They do not go through REST. If either becomes its own process (B2, B3), it must either share the services library and the database (only B1 appears), or call REST, which has no worker authentication today (teacher tokens only; the student routes are development-only, decision 0018). This is a decision for the cloud refactoring.';
