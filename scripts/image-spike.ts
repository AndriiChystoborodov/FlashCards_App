/**
 * Image-card spike (decision 0034, Stage A). RUN BY THE USER against a real workspace: `npm run spike:image -- --email you@example.com`.
 * Needs no database. Tokens come from src/config/env.ts (.env or the environment), like `npm run dev`.
 *
 * It posts four image cards (short, long, Russian, umlauts) ONLY to the DM of --email, waits for a click on each, replaces the
 * message in three different ways and logs what Slack answers. With --email2 it posts the SAME uploaded file id to a second user
 * (reuse across users). With --share starts the ladder with B (the upload shared to the DM channel).
 *
 * Diagnosis ladder (first card; the strategy that works is used for the other cards): A private upload (SDK helper), files.info,
 * post with retries on invalid_blocks (0.5 to 8 s); B upload shared to the DM channel; C the block with slack_file.url instead of id;
 * D the explicit getUploadURLExternal + POST + completeUploadExternal route. A full run with nothing working takes about 70 s.
 *
 * Production code is not changed by the spike: the upload and the image-block post are built here. The client options below
 * duplicate the few lines of createSlack (src/slack/start.ts); only `slackPort(...).lookupEmail` is the production adapter.
 */
import { App, webApi, type types } from '@slack/bolt';
import { renderCard, type CardImage } from '../src/render/card.js';
import { SAMPLES } from '../src/render/samples.js';
import { escapeMrkdwn } from '../src/slack/card.js';
import { BACKOFF_MS, describeFile, imageBlock, postWithReadiness, printableBlock, slackCode, type ImageRef } from '../src/slack/spikeProbe.js';
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
  const c = slackCode(err);
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

function cardBlocks(n: number, ref: ImageRef, alt: string): { text: string; blocks: KnownBlock[] } {
  const list = OPTIONS.map((o, i) => `${i + 1}. ${escapeMrkdwn(o)}`).join('\n');
  const buttons = [...OPTIONS.map((_, i) => button(`answer_${i + 1}`, String(i + 1), JSON.stringify({ c: n, o: i }))), button('answer_dont_know', "Don't know", JSON.stringify({ c: n, o: null }))];
  return {
    text: `Q: ${escapeMrkdwn(alt)}\n${list}`,
    blocks: [imageBlock(ref, alt), { type: 'section', text: { type: 'mrkdwn', text: list } }, { type: 'actions', elements: buttons }],
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
const fileIds = new Map<number, { ref: ImageRef; alt: string }>();
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
    else if (card.variant === 'respond_keep_image') await respond({ text, blocks: [imageBlock(file.ref, file.alt), section], replace_original: true });
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

type Strategy = 'A' | 'B' | 'C' | 'D';
const STRATEGY_NOTE: Record<Strategy, string> = {
  A: 'A: private upload (SDK helper), files.info, post with retries',
  B: 'B: upload shared to the DM channel (puts a separate FILE MESSAGE into your DM), post',
  C: 'C: the block with slack_file.url (url_private from files.info) instead of id',
  D: 'D: explicit files.getUploadURLExternal + POST bytes + files.completeUploadExternal with channel_id, post',
};
let lastUrl: string | undefined; // url_private of the latest uploaded file: used by C, never printed

/** files.info of the uploaded file: prints the fields that matter, keeps url_private for C. Needs files:read; a failure is a finding. */
async function inspect(id: string, label: string): Promise<void> {
  try {
    const info = await web.files.info({ file: id });
    const file = info.file as Record<string, unknown> | undefined;
    if (typeof file?.url_private === 'string') lastUrl = file.url_private;
    console.log(`  files.info (${label}): ${JSON.stringify(describeFile(file))}`);
    // Verified in the first live run: empty mimetype/filetype and no thumbnails right after the upload mean "not processed yet", not a wrong type.
    if (file && !file.mimetype && !file.filetype) console.log('  (mimetype and filetype are empty: the file is not processed yet)');
  } catch (err) {
    console.log(`  files.info (${label}) FAILED: ${why(err)}${slackCode(err) === 'missing_scope' ? ' (files.info needs files:read)' : ''}`);
  }
}

async function uploadSdk(r: CardImage, n: number, channelId?: string): Promise<string> {
  const base = { file: r.png, filename: `card-${n}.png`, alt_text: r.text.slice(0, 1000) };
  const up = await web.filesUploadV2(channelId ? { ...base, channel_id: channelId } : base);
  const f = up.files?.[0]?.files?.[0] as { id?: string } | undefined; // SDK 8.2.0: one completeUploadExternal answer per group, its files[]
  console.log(`  upload (SDK helper) ok=${String(up.ok)} id=${f?.id} ${channelId ? '(shared to the DM)' : '(private)'}; fields of the upload answer: ${f ? Object.keys(f).join(',') : 'none'}`);
  if (!f?.id) throw new Error('upload answered without a file id');
  return f.id;
}

async function uploadManual(r: CardImage, n: number, channelId: string): Promise<string> {
  const g = await web.files.getUploadURLExternal({ filename: `card-${n}.png`, length: r.png.length, alt_text: r.text.slice(0, 1000) });
  if (!g.upload_url || !g.file_id) throw new Error('getUploadURLExternal answered without upload_url or file_id');
  const put = await fetch(g.upload_url, { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array(r.png) });
  console.log(`  manual upload: getUploadURLExternal ok, POST bytes -> HTTP ${put.status}`);
  if (!put.ok) throw new Error(`POST of the bytes failed: HTTP ${put.status}`);
  const done = await web.files.completeUploadExternal({ files: [{ id: g.file_id, title: `card-${n}.png` }], channel_id: channelId });
  console.log(`  completeUploadExternal ok=${String(done.ok)} id=${g.file_id}`);
  return g.file_id;
}

interface Delivered {
  strategy: Strategy;
  ref: ImageRef;
  tUpload: string;
  tPost: string;
  attempts: number;
  waitedMs: number;
  ts?: string;
}

/** Tries the strategies in order for one card and returns the first whose post Slack accepts. */
async function deliver(card: (typeof CARDS)[number], r: CardImage, to: string, dm: string, strategies: Strategy[]): Promise<Delivered | null> {
  for (const strategy of strategies) {
    console.log(`\n  >> ${STRATEGY_NOTE[strategy]}`);
    let ref: ImageRef;
    let t0 = performance.now();
    try {
      if (strategy === 'C') {
        lastUrl = undefined;
        await inspect(await uploadSdk(r, card.n), 'after upload (private)'); // a fresh private upload, then its url_private
        if (!lastUrl) {
          console.log('  skipped: files.info gave no url_private');
          continue;
        }
        ref = { url: lastUrl };
      } else {
        const id = strategy === 'A' ? await uploadSdk(r, card.n) : strategy === 'B' ? await uploadSdk(r, card.n, dm) : await uploadManual(r, card.n, dm);
        ref = { id };
        await inspect(id, 'after upload');
      }
    } catch (err) {
      console.log(`  upload step FAILED: ${why(err)}`);
      continue;
    }
    const tUpload = ms(t0);
    console.log(`  block sent: ${printableBlock(imageBlock(ref, r.text))}`);
    t0 = performance.now();
    const res = await postWithReadiness(() => web.chat.postMessage({ channel: to, ...cardBlocks(card.n, ref, r.text) }), {
      onWait: (wait, attempt) => console.log(`  invalid_blocks (attempt ${attempt}); waiting ${wait / 1000} s and posting again`),
    });
    const tPost = ms(t0);
    if (res.ok) {
      console.log(`  ACCEPTED by Slack after ${res.attempts} attempt(s), ${res.waitedMs / 1000} s of waiting (backoff steps: ${BACKOFF_MS.join('/')} ms); ts=${res.result.ts}`);
      return { strategy, ref, tUpload, tPost, attempts: res.attempts, waitedMs: res.waitedMs, ...(res.result.ts && { ts: res.result.ts }) };
    }
    console.log(`  REJECTED: ${res.code} after ${res.attempts} attempt(s), ${res.waitedMs / 1000} s of waiting`);
    if ('id' in ref) await inspect(ref.id, 'after the failed post');
  }
  return null;
}

async function main() {
  const auth = await web.auth.test();
  console.log(`auth.test ok=${String(auth.ok)}: bot user id=${auth.user_id} app id=${auth.app_id} team=${auth.team} (the same bot token uploads and posts)`);
  const scopes = auth.response_metadata?.scopes;
  console.log(scopes ? `granted scopes (from the response): ${scopes.join(', ')}` : 'granted scopes: not exposed by the client for this call (look at api.slack.com/apps, OAuth & Permissions)');
  if (scopes && !scopes.includes('files:write')) console.log('!! files:write is NOT granted: add it and reinstall the app');
  if (scopes && !scopes.includes('files:read')) console.log('note: files:read is not granted: files.info will fail with missing_scope (a finding, not necessarily the cause)');

  const user = await slackPort(web).lookupEmail(email!);
  if (!user) throw new Error('no Slack user for --email');
  user1 = user.slackId;
  console.log(`user 1 found (${user.slackId}), tz=${user.tz}`);
  await app.start();
  const hello = await web.chat.postMessage({ channel: user.slackId, text: `Image-card spike: ${CARDS.length} cards follow. (This text message was posted only to learn the DM channel id.) Click an answer on each.` });
  const dm = hello.channel;
  console.log(`intro posted (an extra text message): channel=${dm} ts=${hello.ts}`);
  if (!dm) throw new Error('chat.postMessage answered without a channel');

  const rows: string[] = [];
  let winner: Strategy[] = share ? ['B', 'A', 'C', 'D'] : ['A', 'B', 'C', 'D'];
  for (const c of CARDS) {
    console.log(`\n--- card ${c.n} (${c.name}) ---`);
    let t0 = performance.now();
    const r = renderCard(c.q);
    if (!r.ok) throw new Error(`render refused: ${r.code}`);
    const tRender = ms(t0);
    t0 = performance.now();
    const d = await deliver(c, r, user.slackId, dm, winner);
    if (!d) {
      console.log('\nNO STRATEGY WORKED. Paste this whole output back to Claude. Check: files:write granted and the app reinstalled; the mimetype above; whether a separate file message appeared in your DM.');
      return;
    }
    winner = [d.strategy];
    fileIds.set(c.n, { ref: d.ref, alt: r.text });
    console.log(`  ${r.width}x${r.height} font ${r.fontSize}px ${r.png.length} bytes; total for this card ${ms(t0)}`);
    rows.push(`card ${c.n} ${c.name.padEnd(8)} strategy ${d.strategy} render ${tRender.padStart(7)}  upload ${d.tUpload.padStart(7)}  post ${d.tPost.padStart(7)}  attempts ${d.attempts}  waited ${d.waitedMs / 1000} s`);
  }
  console.log(`\nWORKING STRATEGY: ${winner[0]}`);

  if (email2) {
    const other = await slackPort(web).lookupEmail(email2);
    if (!other) console.log('\nreuse across users: user 2 not found');
    else {
      const first = fileIds.get(1)!;
      try {
        const res = await web.chat.postMessage({ channel: other.slackId, ...cardBlocks(1, first.ref, first.alt) });
        console.log(`\nreuse across users: posted the SAME file reference to user 2 (ok=${String(res.ok)}). Ask them whether the image shows.`);
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
