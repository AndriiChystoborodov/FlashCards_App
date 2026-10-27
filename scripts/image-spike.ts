/**
 * Image-card spike (decision 0034, Stage A). RUN BY THE USER against a real workspace: `npm run spike:image -- --email you@example.com`.
 * Needs no database. Tokens come from src/config/env.ts (.env or the environment), like `npm run dev`.
 *
 * It posts four image cards (short, long, Russian, umlauts) ONLY to the DM of --email, waits for a click on each, replaces the
 * message in three different ways and logs what Slack answers. With --email2 it posts the SAME uploaded file id to a second user
 * (reuse across users). With --share the upload is shared to the DM channel instead of being private.
 *
 * Production code is not changed by the spike: the upload and the image-block post are built here. The client options below
 * duplicate the few lines of createSlack (src/slack/start.ts); only `slackPort(...).lookupEmail` is the production adapter.
 */
import { App, webApi, type types } from '@slack/bolt';
import { renderCard, type CardImage } from '../src/render/card.js';
import { SAMPLES } from '../src/render/samples.js';
import { escapeMrkdwn } from '../src/slack/card.js';
import { slackPort } from '../src/slack/web.js';

type KnownBlock = types.KnownBlock;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const valueOf = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const email = valueOf('--email');
const email2 = valueOf('--email2');
const share = flag('--share');
if (!email || !email.includes('@') || (email2 !== undefined && !email2.includes('@'))) {
  console.error('Usage: npm run spike:image -- --email <your Slack email> [--email2 <second user email>] [--share]');
  process.exit(2);
}

console.log('=======================================================================');
console.log(' STOP `npm run dev` FIRST: two Socket Mode connections split the clicks.');
console.log(' This spike needs no database and posts only to the DM of --email' + (email2 ? ' and --email2.' : '.'));
console.log('=======================================================================');

// env.ts demands DATABASE_URL unless NODE_ENV=test; the spike has no database. dotenv never overrides a variable that is already set.
process.env.NODE_ENV = 'test';
let env: Awaited<typeof import('../src/config/env.js')>['env'];
try {
  ({ env } = await import('../src/config/env.js'));
} catch (err) {
  console.error(err instanceof Error ? err.message : 'Invalid environment'); // names the variables, never their values
  process.exit(1);
}

/** The platform's error code only: client errors can carry request details. */
const why = (err: unknown): string => {
  const { data, code } = (typeof err === 'object' && err !== null ? err : {}) as { data?: { error?: unknown }; code?: unknown };
  const c = typeof data?.error === 'string' ? data.error : typeof code === 'string' ? code : 'unknown';
  return c === 'missing_scope' ? `${c} (add files:write to the app, reinstall it, and use the new token)` : c;
};
const ms = (t0: number) => `${(performance.now() - t0).toFixed(0)} ms`;

const app = new App({
  token: env.SLACK_BOT_TOKEN,
  appToken: env.SLACK_APP_TOKEN,
  socketMode: true,
  clientOptions: { retryConfig: webApi.retryPolicies.fiveRetriesInFiveMinutes, timeout: 15_000 },
});
const web = app.client;

const OPTIONS = ['Option A', 'Option B', 'Option C'];
const button = (id: string, label: string, value: string) => ({ type: 'button' as const, action_id: id, text: { type: 'plain_text' as const, text: label }, value });
const imageBlock = (fileId: string, alt: string): KnownBlock => ({ type: 'image', slack_file: { id: fileId }, alt_text: alt.slice(0, 2000) });

function cardBlocks(n: number, fileId: string, alt: string): { text: string; blocks: KnownBlock[] } {
  const list = OPTIONS.map((o, i) => `${i + 1}. ${escapeMrkdwn(o)}`).join('\n');
  const buttons = [...OPTIONS.map((_, i) => button(`answer_${i + 1}`, String(i + 1), JSON.stringify({ c: n, o: i }))), button('answer_dont_know', "Don't know", JSON.stringify({ c: n, o: null }))];
  return {
    text: `Q: ${escapeMrkdwn(alt)}\n${list}`,
    blocks: [imageBlock(fileId, alt), { type: 'section', text: { type: 'mrkdwn', text: list } }, { type: 'actions', elements: buttons }],
  };
}

const CARDS = [
  { n: 1, name: 'short', q: SAMPLES.short, variant: 'respond_text' },
  { n: 2, name: 'long', q: SAMPLES.long, variant: 'respond_text' },
  { n: 3, name: 'russian', q: SAMPLES.russian, variant: 'respond_keep_image' },
  { n: 4, name: 'umlauts', q: SAMPLES.umlauts, variant: 'chat_update' },
] as const;
type Variant = (typeof CARDS)[number]['variant'];
const VARIANT_NOTE: Record<Variant, string> = {
  respond_text: 'response_url replace_original with text only: expect the IMAGE TO BE GONE',
  respond_keep_image: 'response_url replace_original with the same slack_file image block + text: expect the IMAGE TO STAY',
  chat_update: 'chat.update with text and no image block: expect the IMAGE TO BE GONE',
};
const fileIds = new Map<number, { id: string; alt: string }>();
const clicked = new Set<number>();
let user1: string | undefined;
let finish: () => void = () => undefined;
const allClicked = new Promise<void>((resolve) => (finish = resolve));

app.action(/^answer_/, async ({ ack, action, body, respond }) => {
  await ack();
  const actionId = 'action_id' in action ? action.action_id : '?';
  const raw = 'value' in action ? action.value : undefined;
  let n = -1;
  try {
    n = (JSON.parse(String(raw)) as { c: number }).c;
  } catch {
    // malformed: logged below with n = -1
  }
  const blocks = (body.type === 'block_actions' ? body.message?.blocks : undefined) as { type?: string; slack_file?: unknown }[] | undefined;
  const msgImage = blocks?.find((b) => b.type === 'image');
  console.log(`\n[click] card ${n} by ${body.user.id === user1 ? 'user 1' : 'another user'} action_id=${actionId}`);
  console.log(`  message ts=${body.type === 'block_actions' ? body.message?.ts : '?'} container.type=${body.type === 'block_actions' ? body.container.type : '?'}`);
  console.log(`  body.message block types: [${blocks?.map((b) => b.type).join(', ') ?? 'none'}]`);
  console.log(`  body contains the image block: ${msgImage ? 'yes' : 'NO'}; its slack_file key present: ${msgImage && 'slack_file' in msgImage ? 'yes' : 'no'}`);
  const card = CARDS.find((c) => c.n === n);
  const file = fileIds.get(n);
  if (!card || !file) return console.log('  unknown card, ignored');
  const text = `Spike: you clicked "${actionId}" on card ${n} (${card.name}).`;
  const section: KnownBlock = { type: 'section', text: { type: 'mrkdwn', text } };
  try {
    if (card.variant === 'respond_text') await respond({ text, replace_original: true });
    else if (card.variant === 'respond_keep_image') await respond({ text, blocks: [imageBlock(file.id, file.alt), section], replace_original: true });
    else if (body.type === 'block_actions' && body.channel && body.message) await web.chat.update({ channel: body.channel.id, ts: body.message.ts, text, blocks: [section] });
    console.log(`  replace result: ok (${card.variant})`);
  } catch (err) {
    console.log(`  replace result: FAILED ${why(err)} (${card.variant})`);
  }
  console.log(`  LOOK IN SLACK: ${VARIANT_NOTE[card.variant]}. Tell Claude what you see.`);
  if (body.user.id === user1) {
    clicked.add(n);
    if (clicked.size === CARDS.length) finish();
  }
});

async function main() {
  const user = await slackPort(web).lookupEmail(email!);
  if (!user) throw new Error('no Slack user for --email');
  user1 = user.slackId;
  console.log(`user 1 found (${user.slackId}), tz=${user.tz}`);
  await app.start();
  const hello = await web.chat.postMessage({ channel: user.slackId, text: `Image-card spike: ${CARDS.length} cards follow. Click an answer on each.` });
  const dm = hello.channel;
  console.log(`intro posted: channel=${dm} ts=${hello.ts}`);
  if (share && !dm) throw new Error('--share needs the DM channel id');

  const rows: string[] = [];
  for (const c of CARDS) {
    console.log(`\n--- card ${c.n} (${c.name}) ---`);
    let t0 = performance.now();
    const r = renderCard(c.q);
    if (!r.ok) throw new Error(`render refused: ${r.code}`);
    const tRender = ms(t0);
    t0 = performance.now();
    const up = await web.filesUploadV2(share ? { file: r.png, filename: `card-${c.n}.png`, alt_text: r.text.slice(0, 1000), channel_id: dm! } : { file: r.png, filename: `card-${c.n}.png`, alt_text: r.text.slice(0, 1000) });
    const tUpload = ms(t0);
    const f = up.files?.[0]?.files?.[0] as { id?: string } | undefined;
    if (!f?.id) throw new Error('upload answered without a file id');
    console.log(`  upload ok=${String(up.ok)} file_id=${f.id} (${share ? 'shared to the DM' : 'private'}); file fields: ${Object.keys(f).join(',')}`);
    fileIds.set(c.n, { id: f.id, alt: r.text });
    t0 = performance.now();
    const posted = await web.chat.postMessage({ channel: user.slackId, ...cardBlocks(c.n, f.id, r.text) });
    const tPost = ms(t0);
    console.log(`  post ok=${String(posted.ok)} channel=${posted.channel} ts=${posted.ts}; ${r.width}x${r.height} font ${r.fontSize}px ${r.png.length} bytes`);
    rows.push(`card ${c.n} ${c.name.padEnd(8)} render ${tRender.padStart(7)}  upload ${tUpload.padStart(7)}  post ${tPost.padStart(7)}`);
  }

  if (email2) {
    const other = await slackPort(web).lookupEmail(email2);
    if (!other) console.log('\nreuse across users: user 2 not found');
    else {
      const first = fileIds.get(1)!;
      try {
        const res = await web.chat.postMessage({ channel: other.slackId, ...cardBlocks(1, first.id, first.alt) });
        console.log(`\nreuse across users: posted the SAME file id to user 2 (ok=${String(res.ok)}). Ask them whether the image shows.`);
      } catch (err) {
        console.log(`\nreuse across users: Slack REFUSED the post: ${why(err)}`);
      }
    }
  } else console.log('\nreuse across users: unverified (no --email2)');

  console.log('\nTimings:\n' + rows.join('\n'));
  console.log('\nNow click an answer on each of the 4 cards in Slack (Ctrl+C to stop early).');
  await allClicked;
  console.log('\nAll 4 cards clicked. Done.');
}

const stop = async (code: number) => {
  await app.stop().catch(() => undefined);
  process.exit(code);
};
process.on('SIGINT', () => void stop(130));
main().then(
  () => stop(0),
  (err) => {
    console.error(`spike failed: ${err instanceof Error && err.message.startsWith('no Slack') ? err.message : why(err)}`);
    return stop(1);
  },
);
