import { App, webApi } from '@slack/bolt';
import type { SchedulerDeps } from '../services/scheduler.js';
import { registerHandlers } from './handlers.js';
import type { SlackPort } from './port.js';
import { slackPort } from './web.js';

export interface SlackRuntime {
  port: SlackPort;
  /** Routes the button clicks to the services; call before `start`. */
  handle(deps: SchedulerDeps): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The real Slack side of the process (decision 0002, socket mode). The Web client gets a bounded retry policy and a timeout:
 * its default is ten retries over about 30 minutes and no timeout, which would hold one `sendNext` that long during an outage.
 * Not covered by tests: it needs a live workspace (see docs/slack/live-run.md).
 */
export function createSlack(tokens: { botToken: string; appToken: string }): SlackRuntime {
  const app = new App({
    token: tokens.botToken,
    appToken: tokens.appToken,
    socketMode: true,
    clientOptions: { retryConfig: webApi.retryPolicies.fiveRetriesInFiveMinutes, timeout: 15_000 },
  });
  return {
    port: slackPort(app.client),
    handle: (deps) => registerHandlers(app, deps),
    start: async () => void (await app.start()),
    stop: async () => void (await app.stop()),
  };
}
