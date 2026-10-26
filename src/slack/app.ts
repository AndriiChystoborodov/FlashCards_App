import { App } from '@slack/bolt';
import { env } from '../config/env.js';
import { SPIKE_CARD, buildCardMessage } from './card.js';
import { registerSpikeHandlers } from './spikeHandlers.js';

export async function startSpike(): Promise<void> {
  if (!env.SLACK_TEST_USER_ID) throw new Error('SLACK_TEST_USER_ID is required for the spike');
  if (!env.SLACK_APP_TOKEN) throw new Error('SLACK_APP_TOKEN is required for the spike');
  const app = new App({ token: env.SLACK_BOT_TOKEN, appToken: env.SLACK_APP_TOKEN, socketMode: true });
  registerSpikeHandlers(app);
  await app.start();
  // chat.postMessage with a user id as channel opens the DM (only chat:write needed).
  await app.client.chat.postMessage({ channel: env.SLACK_TEST_USER_ID, ...buildCardMessage(SPIKE_CARD) });
  console.log('Spike running: test card sent. Click a button in Slack. Ctrl+C to stop.');
}
