import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClickArgs } from './handlers.js';
import { registerSpikeHandlers } from './spikeHandlers.js';

type Handler = (a: ClickArgs) => Promise<void>;

function setup() {
  const routes: { pattern: RegExp; handler: Handler }[] = [];
  registerSpikeHandlers(
    { action: (pattern, handler) => void routes.push({ pattern, handler }) },
    { clock: { now: () => new Date('2026-10-25T10:00:00.000Z') } },
  );
  const calls: string[] = [];
  const respond = vi.fn(async () => void calls.push('respond'));
  const click = async (actionId: string, value: unknown, user = 'U1') => {
    const ack = vi.fn(async () => void calls.push('ack'));
    const route = routes.find((r) => r.pattern.test(actionId));
    if (!route) throw new Error(`no route for ${actionId}`);
    await route.handler({ ack, action: value === undefined ? { action_id: actionId } : { action_id: actionId, value } as ClickArgs['action'], body: { user: { id: user } }, respond });
    return ack;
  };
  return { click, respond, calls };
}

const lastText = (respond: ReturnType<typeof setup>['respond']) =>
  (respond.mock.calls as unknown as [{ text: string; replace_original: boolean }][]).at(-1)![0];

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('answer_ handler', () => {
  it('H8: routes answer_1..3 and answer_dont_know, rate_* separately', async () => {
    const { click, respond } = setup();
    for (const id of ['answer_1', 'answer_2', 'answer_3', 'answer_dont_know']) {
      await click(id, '{"c":"spike-1","o":0}', `U-${id}`);
    }
    expect(respond).toHaveBeenCalledTimes(4);
  });

  it('H1: ack is called before respond', async () => {
    const { click, calls } = setup();
    await click('answer_2', '{"c":"spike-1","o":1}');
    expect(calls).toEqual(['ack', 'respond']);
  });

  it('H5: right answer shows rating buttons and replaces the message', async () => {
    const { click, respond } = setup();
    await click('answer_2', '{"c":"spike-1","o":1}');
    const m = lastText(respond);
    expect(m.text).toBe('Right. How hard was it?');
    expect(m.replace_original).toBe(true);
    expect(JSON.stringify(m)).toContain('rate_hard');
  });

  it('H7: wrong answer shows the right answer, no buttons', async () => {
    const { click, respond } = setup();
    await click('answer_1', '{"c":"spike-1","o":0}');
    expect(lastText(respond).text).toBe('Not quite. The right answer is 2: 500.');
    expect(JSON.stringify(lastText(respond))).not.toContain('actions');
  });

  it("H7: Don't know shows the right answer", async () => {
    const { click, respond } = setup();
    await click('answer_dont_know', '{"c":"spike-1","o":null}');
    expect(lastText(respond).text).toBe('Not quite. The right answer is 2: 500.');
  });

  it('logs ISO timestamp, user, action_id and value', async () => {
    const { click } = setup();
    await click('answer_1', '{"c":"spike-1","o":0}');
    expect(log).toHaveBeenCalledWith('[2026-10-25T10:00:00.000Z] click user=U1 action_id=answer_1 value={"c":"spike-1","o":0}');
  });

  it('a second answer after a wrong one gets "already answered"', async () => {
    const { click, respond } = setup();
    await click('answer_1', '{"c":"spike-1","o":0}');
    await click('answer_3', '{"c":"spike-1","o":2}');
    expect(lastText(respond).text).toBe('This card was already answered.');
  });

  it('unknown card id: ack, warn, no respond', async () => {
    const { click, respond } = setup();
    const ack = await click('answer_1', '{"c":"nope","o":0}');
    expect(ack).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });
});

describe('H3: malformed values', () => {
  const answerBad: unknown[] = [undefined, 42, 'not json', '{"c":"spike-1"}', '{"c":"spike-1","o":-1}', '{"c":"spike-1","o":1.5}'];
  const rateBad: unknown[] = [undefined, 42, 'not json', '{"c":"spike-1","o":1}', '{"c":"spike-1","o":-1,"r":"easy"}', '{"c":"spike-1","o":1.5,"r":"easy"}', '{"c":"spike-1","o":1,"r":"great"}'];

  it.each(answerBad)('answer_ ignores %j', async (value) => {
    const { click, respond } = setup();
    const ack = await click('answer_1', value);
    expect(ack).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(respond).not.toHaveBeenCalled();
  });

  it.each(rateBad)('rate_ ignores %j', async (value) => {
    const { click, respond } = setup();
    const ack = await click('rate_easy', value);
    expect(ack).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(respond).not.toHaveBeenCalled();
  });
});

describe('rate_ handler', () => {
  it('H6/H10: logs user, card, option, rating and replaces the message with no buttons', async () => {
    const { click, respond, calls } = setup();
    await click('rate_easy', '{"c":"spike-1","o":1,"r":"easy"}');
    expect(calls).toEqual(['ack', 'respond']);
    expect(log).toHaveBeenCalledWith('rating user=U1 card=spike-1 option=1 rating=easy');
    expect(lastText(respond).text).toBe('Thanks. You rated it Easy.');
    expect(JSON.stringify(lastText(respond))).not.toContain('actions');
  });

  it('a second rating click gets "already answered"', async () => {
    const { click, respond } = setup();
    await click('rate_hard', '{"c":"spike-1","o":1,"r":"hard"}');
    await click('rate_easy', '{"c":"spike-1","o":1,"r":"easy"}');
    expect(lastText(respond).text).toBe('This card was already answered.');
  });

  it('H10: rating with a wrong option (forged value) is ignored', async () => {
    const { click, respond } = setup();
    await click('rate_easy', '{"c":"spike-1","o":0,"r":"easy"}');
    expect(warn).toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('unknown card id: warn, no respond', async () => {
    const { click, respond } = setup();
    await click('rate_easy', '{"c":"nope","o":1,"r":"easy"}');
    expect(warn).toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });
});
