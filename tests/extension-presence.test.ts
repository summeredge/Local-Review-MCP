import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it('reports presence at startup, periodically and on page resume without business readiness', async () => {
  const source = await readFile('extension/content.js', 'utf8');
  const messages: Record<string, unknown>[] = [];
  const events = new Map<string, () => void>();
  const intervals = new Map<number, () => void>();
  let workerListener: ((message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean) | undefined;
  const document = {
    visibilityState: 'hidden', documentElement: null,
    addEventListener: (name: string, callback: () => void) => events.set(name, callback),
  };
  runInNewContext(source, {
    window: {
      addEventListener: (name: string, callback: () => void) => events.set(name, callback),
      removeEventListener: () => undefined, postMessage: () => undefined,
    },
    document, location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' },
    history: {}, URL, setTimeout: () => 0, clearTimeout: () => undefined,
    setInterval: (callback: () => void, ms: number) => { intervals.set(ms, callback); return 0; },
    LRM_DOM: { ready: () => false },
    chrome: { runtime: { onMessage: { addListener: (listener: typeof workerListener) => { workerListener = listener; } }, sendMessage: (message: Record<string, unknown>) => {
      messages.push(message);
      throw new Error('worker temporarily unavailable');
    } } },
  });
  const count = () => messages.filter(message => message.type === 'presence').length;
  expect(count()).toBe(1);
  for (let elapsed = 3000; elapsed <= 15000; elapsed += 3000) intervals.get(3000)!();
  expect(count()).toBe(6);
  events.get('focus')!();
  events.get('pageshow')!();
  events.get('visibilitychange')!();
  expect(count()).toBe(8);
  document.visibilityState = 'visible';
  events.get('visibilitychange')!();
  expect(count()).toBe(9);
  const replies: unknown[] = [];
  expect(workerListener!({ type: 'presence_probe' }, {}, value => replies.push(value))).toBe(false);
  expect(count()).toBe(10);
  expect(replies).toEqual([{ ok: true }]);
  expect(messages.some(message => ['delivery_claim', 'completion_claim', 'identity_evidence'].includes(String(message.type)))).toBe(false);
});
