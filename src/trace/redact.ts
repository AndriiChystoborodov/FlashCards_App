// Redaction for the API trace (decision 0032). Everything the recorder stores goes through here first; the files are checked again with `assertClean`.
// Placeholders are aliases numbered by first sight (`student-1`, `U-1`, `course-2`), so a run is readable and a baseline stays diff-able.

const MAX_STRING = 2000;
const SCAN_LIMIT = 5000;
const MAX_ITEMS = 200;
const MAX_DEPTH = 24;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Anything of the form local@domain: the lookbehind makes the scan linear (it starts only at the beginning of a run), the domain needs no dot.
const EMAIL = /(?<![^\s@<>()",;:\\])(?:"[^"\n]{1,64}"|[^\s@<>()",;:\\]+)@[^\s@<>,;"']+/g;
const BEARER = /\bbearer\W{1,12}[A-Za-z0-9._~+\/=-]{6,}/gi;
const BASIC = /\bbasic\s+[A-Za-z0-9+\/=]{8,}/gi;
const SLACK_TOKEN = /\bx(?:ox[a-z]|app|oxe|wfp)[-._\s][\w.-]{3,}|\bgh[pousr]_\w{8,}|hooks\.slack\.com\/services\/\S+/gi;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g;
// key=value pairs (query strings, DSNs, cookies) whose key names a secret
const SECRET_PAIR = /\b(?:password|passwd|pwd|pass|secret|token|apikey|api_key|access_token|jsessionid|sessionid|session|sig|signature|key|auth)=[^&\s;,"']+/gi;
const DB_URL = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'/@]*@[^\s"']*|\bpostgres(?:ql)?:\/\/[^@\n]{0,200}@\S*|\bpostgres(?:ql)?:\/\/[^\s"']*|(?<![\w.-])[\w.-]+:[^\s@\/:]+@[\w.-]+:\d{2,5}\b/gi;
// real ids contain a digit; an all-letter word (CONTAINERS) is not an id
const SLACK_ID = /(?<![A-Za-z0-9])(?=[A-Z0-9]*\d)[UWDCTBG][A-Z0-9]{7,}(?![A-Za-z0-9])/g;
const BARE_TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const INVISIBLE = /\p{Cf}/gu; // zero-width and format characters: removed, so they cannot split a pattern

const hasLetterAndDigit = (s: string) => /[A-Za-z]/.test(s) && /\d/.test(s);
/** Long enough that it is a credential, not a word: mixed letters and digits from 20, letters only from 32, digits only from 20. */
const looksLikeToken = (s: string) => hasLetterAndDigit(s) || s.length >= 32 || /^\d+$/.test(s);

/** What a reader or a decoder would see: NFKC, invisible characters gone, HTML numeric entities and percent-encoding (up to three layers) decoded. */
function normalise(input: string): string {
  let s = input.normalize('NFKC').replace(INVISIBLE, '');
  s = s.replace(/&#(\d{1,7});/g, (m, n: string) => (Number(n) < 0x110000 ? String.fromCodePoint(Number(n)) : m)).replace(/\\u0040/gi, '@');
  for (let i = 0; i < 3 && s.includes('%'); i++) {
    try {
      const d = decodeURIComponent(s);
      if (d === s) break;
      s = d;
    } catch {
      break;
    }
  }
  return s.replace(/&#x([0-9a-f]{1,6});/gi, (m, n: string) => (parseInt(n, 16) < 0x110000 ? String.fromCodePoint(parseInt(n, 16)) : m));
}

/** Keys whose value is never kept, whatever it is. */
const SECRET_KEY = /token|secret|password|passwd|passphrase|authoriz|cookie|apikey|credential|bearer|jwt|session|signature|privatekey|^(?:pwd|pass|auth|key|sig)$/;
const NAME_KEY = /name$/;
const NOT_A_PERSON = /^(?:file|class|table|host|schema|event|action|key|type|column|display_?field)name$/;
const normKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type Hint = 'course' | 'card' | 'student' | 'teacher' | 'id';

function hintOfKey(key: string): Hint {
  const k = normKey(key);
  if (k.startsWith('course')) return 'course';
  if (k.startsWith('flashcard') || k.startsWith('card')) return 'card';
  if (k.startsWith('student') || k.startsWith('user')) return 'student';
  return 'id';
}

export interface Redactor {
  /** Registers a live secret (token, URL): every occurrence, in any case, URL-encoded or not, becomes `[secret]`. */
  addSecret(value: string | undefined | null): void;
  /** Gives an email a readable alias prefix (`teacher`, `student`); the first label wins. */
  label(email: string, prefix: 'teacher' | 'student'): void;
  /** Registers a (possibly fake) Slack id so it is replaced even when it does not look like a real one. */
  addSlackId(id: string): void;
  /** An alias for a Slack user id, for places that know it is one (a click's user). */
  slackId(id: string): string;
  /** Redacts one string (a path, a message, an error text). */
  text(s: string, hint?: Hint): string;
  /** Redacts a JSON-like value: strings, object keys and values by key name. */
  json(v: unknown, depth?: number): unknown;
  /** A concrete path with ids aliased by the parameter names of its route template. */
  path(path: string, template: string | null): string;
  /** Throws (naming only the detectors that fired) when serialized output still holds something that looks secret. */
  assertClean(serialized: string): void;
}

export function createRedactor(): Redactor {
  const secrets = new Set<string>();
  let secretRe: RegExp | null = null;
  const aliases = new Map<string, string>(); // `${kind}:${raw}` -> alias
  const counters = new Map<string, number>();
  const labels = new Map<string, string>(); // lower-case email -> prefix
  const slackIds = new Set<string>();

  const alias = (kind: string, raw: string, prefix: string): string => {
    if (kind === 'uuid') prefix = prefix === 'student' ? 'user-id' : prefix; // `student-N` is for e-mails, so ids and e-mails do not share numbers
    const key = `${kind}:${raw}`;
    let a = aliases.get(key);
    if (!a) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      a = `${prefix}-${n}`;
      aliases.set(key, a);
    }
    return a;
  };
  const rebuildSecrets = () => {
    const all = [...secrets].flatMap((s) => [s, encodeURIComponent(s), encodeURIComponent(encodeURIComponent(s)), s.replace(/ /g, '+'), Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url'), Buffer.from(s).toString('hex')]);
    secretRe = all.length ? new RegExp([...new Set(all)].sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'giu') : null;
  };
  const slackAlias = (id: string) => alias('slack', id, id.startsWith('D') ? 'D' : id.startsWith('C') ? 'C' : 'U');
  const emailAlias = (raw: string) => {
    let e = raw;
    try {
      e = decodeURIComponent(raw);
    } catch {
      // keep the raw text
    }
    e = e.replace(/\\u0040/gi, '@').toLowerCase();
    return alias('email', e, labels.get(e) ?? 'user');
  };

  function text(input: string, hint: Hint = 'id'): string {
    const raw = typeof input === 'string' ? input : String(input);
    // The scans below are quadratic on some inputs, so the cut comes first; the tail is dropped, never kept unscanned.
    const cut = raw.length > SCAN_LIMIT ? raw.length - SCAN_LIMIT : 0;
    let s = normalise(cut ? raw.slice(0, SCAN_LIMIT) : raw).replace(CONTROL, '\u00b7');
    if (secretRe) s = s.replace(secretRe, '[secret]');
    s = s.replace(BEARER, 'Bearer [token]').replace(BASIC, 'Basic [token]').replace(SLACK_TOKEN, '[slack-token]').replace(JWT, '[token]');
    s = s.replace(DB_URL, '[url-with-credentials]').replace(SECRET_PAIR, (m) => `${m.split('=')[0]}=[redacted]`);
    s = s.replace(EMAIL, (m) => emailAlias(m));
    s = s.replace(UUID, (m) => alias('uuid', m.toLowerCase(), hint === 'id' ? 'id' : hint));
    for (const id of slackIds) s = s.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(id)}(?![A-Za-z0-9])`, 'gi'), () => slackAlias(id)); // whole tokens only, so a short id does not rewrite words
    s = s.replace(SLACK_ID, (m) => slackAlias(m));
    s = s.replace(BARE_TOKEN, (m) => (looksLikeToken(m) ? '[token]' : m));
    const total = s.length + cut;
    return total > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[truncated ${total - MAX_STRING}]` : s;
  }

  function json(v: unknown, depth = 0): unknown {
    try {
      return jsonInner(v, depth);
    } catch {
      return '[unserializable]'; // a getter or proxy that throws must not break the call being recorded
    }
  }

  function jsonInner(v: unknown, depth: number): unknown {
    if (v === null || v === undefined) return v ?? null;
    if (typeof v === 'string') return text(v);
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return String(v);
    if (v instanceof String) return text(v.valueOf());
    if (v instanceof Number || v instanceof Boolean) return v.valueOf();
    if (v instanceof Uint8Array || v instanceof ArrayBuffer) return `[binary ${v.byteLength} bytes]`;
    if (v instanceof Map || v instanceof Set) return `[${v instanceof Map ? 'map' : 'set'}]`;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    if (depth >= MAX_DEPTH) return '[too deep]';
    if (Array.isArray(v)) {
      const out = v.slice(0, MAX_ITEMS).map((x) => json(x, depth + 1));
      if (v.length > MAX_ITEMS) out.push(`[${v.length - MAX_ITEMS} more]`);
      return out;
    }
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v).slice(0, MAX_ITEMS)) {
        const nk = normKey(k);
        let safeKey = text(k);
        while (safeKey in out) safeKey += '_';
        if (SECRET_KEY.test(nk)) out[safeKey] = '[redacted]';
        else if (nk === 'email' && typeof x === 'string') out[safeKey] = emailAlias(x);
        else if (NAME_KEY.test(nk) && !NOT_A_PERSON.test(nk)) out[safeKey] = typeof x === 'string' ? alias('name', x, 'name') : '[redacted]';
        else if (nk === 'slackid' && typeof x === 'string') out[safeKey] = slackAlias(x);
        else if (typeof x === 'string') out[safeKey] = text(x, hintOfKey(k));
        else out[safeKey] = json(x, depth + 1);
      }
      return out;
    }
    return text(String(v)); // a symbol or function: its text can hold anything
  }

  function path(p: string, template: string | null): string {
    const [pathPart, ...query] = p.split('?');
    const real = pathPart!.split('/');
    const tpl = template?.split('/') ?? [];
    const out = real.map((seg, i) => {
      const t = tpl[i];
      return t?.startsWith(':') ? text(seg, hintOfKey(t.slice(1))) : text(seg);
    });
    return out.join('/') + (query.length ? `?${text(query.join('?'))}` : '');
  }

  function assertClean(serialized: string): void {
    const hits: string[] = [];
    const seen = normalise(serialized); // what a decoder would see: encoded forms are checked too
    const probe = (name: string, re: RegExp, ok?: (m: string) => boolean) => {
      for (const m of seen.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
        if (!ok || ok(m[0])) {
          hits.push(name);
          return;
        }
      }
    };
    probe('email', EMAIL);
    probe('bearer', BEARER, (m) => !/^bearer\W+redacted$/i.test(m)); // a key named bearer holds the placeholder
    probe('basic-auth', BASIC);
    probe('slack-token', SLACK_TOKEN, (m) => m !== '[slack-token]');
    probe('jwt', JWT);
    probe('secret-pair', SECRET_PAIR, (m) => !m.endsWith('=[redacted]'));
    probe('db-url', DB_URL);
    probe('uuid', UUID);
    probe('slack-id', SLACK_ID);
    probe('token', BARE_TOKEN, looksLikeToken);
    if (secretRe && new RegExp(secretRe.source, 'iu').test(seen)) hits.push('registered-secret');
    for (const id of slackIds) if (new RegExp(`(?<![A-Za-z0-9])${escapeRe(id)}(?![A-Za-z0-9])`, 'i').test(seen)) hits.push('registered-slack-id');
    if (hits.length) throw new Error(`the trace still holds sensitive-looking text (${[...new Set(hits)].join(', ')}); nothing was written`);
  }

  return {
    addSecret(value) {
      if (!value || value.length < 6) return; // shorter values would also replace ordinary words
      secrets.add(value);
      rebuildSecrets();
    },
    label(email, prefix) {
      const e = email.toLowerCase();
      if (!labels.has(e)) labels.set(e, prefix);
    },
    addSlackId(id) {
      if (id.length >= 3) slackIds.add(id);
    },
    slackId: slackAlias,
    text,
    json,
    path,
    assertClean,
  };
}
