import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnalytics, isValidEventName, propsBytes, randomUuid, screenName, trimProps, webStorage, type AnalyticsConfig, type AnalyticsEvent } from './index.js';

const memoryStorage = (initial: Record<string, unknown> = {}) => {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    load: vi.fn(async (key: string) => (data.has(key) ? structuredClone(data.get(key)) : null)),
    save: vi.fn(async (key: string, value: unknown) => void data.set(key, structuredClone(value))),
  };
};

type Call = { fn: string; device: string; events: AnalyticsEvent[] };
const fakeSupabase = () => {
  const calls: Call[] = [];
  const state = { fail: false, reject: false };
  const client = {
    rpc: vi.fn(async (fn: string, args: { p_device: string; p_events: AnalyticsEvent[] }) => {
      if (state.reject) throw new Error('offline');
      calls.push({ fn, device: args.p_device, events: structuredClone(args.p_events) });
      return { error: state.fail ? { message: 'boom' } : null };
    }),
  };
  return { client, calls, state };
};

const lifecycle = () => {
  const handlers = { background: [] as Array<() => void>, foreground: [] as Array<() => void> };
  return {
    handlers,
    onBackground: (cb: () => void) => {
      handlers.background.push(cb);
      return { remove: () => void handlers.background.splice(handlers.background.indexOf(cb), 1) };
    },
    onForeground: (cb: () => void) => {
      handlers.foreground.push(cb);
      return () => void handlers.foreground.splice(handlers.foreground.indexOf(cb), 1);
    },
    background: () => handlers.background.forEach(cb => cb()),
    foreground: () => handlers.foreground.forEach(cb => cb()),
  };
};

const setup = (overrides: Partial<AnalyticsConfig> = {}, initialStorage: Record<string, unknown> = {}) => {
  const storage = memoryStorage(initialStorage);
  const supabase = fakeSupabase();
  const life = lifecycle();
  const analytics = createAnalytics({
    getSupabase: () => supabase.client,
    storage,
    platform: 'android',
    getVersion: () => '1.2.0 (12)',
    getLanguage: () => 'es',
    onBackground: life.onBackground,
    onForeground: life.onForeground,
    ...overrides,
  });
  return { analytics, storage, supabase, life };
};

const sentEvents = (calls: Call[]) => calls.flatMap(call => call.events);
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('names and props', () => {
  it('accepts the names the database accepts', () => {
    expect(isValidEventName('app_open')).toBe(true);
    expect(isValidEventName('a')).toBe(true);
    expect(isValidEventName('a'.repeat(60))).toBe(true);
    expect(isValidEventName('a'.repeat(61))).toBe(false);
    expect(isValidEventName('App_open')).toBe(false);
    expect(isValidEventName('1open')).toBe(false);
    expect(isValidEventName('_open')).toBe(false);
    expect(isValidEventName('app-open')).toBe(false);
    expect(isValidEventName('')).toBe(false);
  });

  it('keeps flat primitives only', () => {
    expect(trimProps({ a: 'x', b: 1, c: true, d: null, e: { f: 1 }, g: [1], h: undefined, i: NaN, j: () => 1 }, 1800)).toEqual({ a: 'x', b: 1, c: true, d: null, i: null });
    expect(trimProps(null, 1800)).toEqual({});
    expect(trimProps([1, 2], 1800)).toEqual({});
  });

  it('trims props under the size limit', () => {
    const big = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key_${i}`, 'ñ'.repeat(300)]));
    const trimmed = trimProps(big, 1800);
    expect(propsBytes(trimmed)).toBeLessThanOrEqual(1800);
    expect(Object.keys(trimmed).length).toBeGreaterThan(0);
    expect(trimProps({ s: 'x'.repeat(5000) }, 1800).s).toHaveLength(300);
    const manySmall = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    expect(propsBytes(trimProps(manySmall, 1800))).toBeLessThanOrEqual(1800);
  });

  it('groups screens: ids, handles and numbers out', () => {
    expect(screenName('/patterns/6a54a521-29c8-454a-92d4-3857223886a6/tejer')).toBe('/patterns/:id/tejer');
    expect(screenName('/@lucia')).toBe('/@:handle');
    expect(screenName('/aprender/3')).toBe('/aprender/:n');
    expect(screenName('')).toBe('/');
    expect(screenName('/x'.repeat(100))).toHaveLength(80);
  });

  it('makes lowercase uuids the server accepts', () => {
    expect(randomUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('queue and sending', () => {
  it('sends after 8 s with the track_events contract', async () => {
    const { analytics, supabase } = setup();
    await settle();
    analytics.track('screen', { path: '/home' });
    await vi.advanceTimersByTimeAsync(7999);
    expect(supabase.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(supabase.calls).toHaveLength(1);
    const [call] = supabase.calls;
    expect(call!.fn).toBe('track_events');
    expect(call!.device).toMatch(/^[0-9a-f-]{36}$/);
    expect(call!.events).toEqual([
      { name: 'screen', at: '2026-11-13T10:00:00.000Z', session: analytics.sessionId(), props: { path: '/home' }, v: '1.2.0 (12)', platform: 'android', lang: 'es' },
    ]);
  });

  it('waits for 8 s of quiet (each event restarts the timer)', async () => {
    const { analytics, supabase } = setup();
    analytics.track('a');
    await vi.advanceTimersByTimeAsync(5000);
    analytics.track('b');
    await vi.advanceTimersByTimeAsync(5000);
    expect(supabase.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sentEvents(supabase.calls).map(e => e.name)).toEqual(['a', 'b']);
  });

  it('sends in batches of 100, at once when a batch is full', async () => {
    const { analytics, supabase } = setup();
    await settle();
    for (let i = 0; i < 250; i++) analytics.track('tap', { i });
    await vi.advanceTimersByTimeAsync(0);
    await analytics.flush();
    expect(supabase.calls.map(c => c.events.length)).toEqual([100, 100, 50]);
    expect(sentEvents(supabase.calls).map(e => e.props.i)).toEqual(Array.from({ length: 250 }, (_, i) => i));
  });

  it('respects a smaller batch and never more than 100', async () => {
    const small = setup({ batch: 2 });
    ['a', 'b', 'c'].forEach(n => small.analytics.track(n));
    await small.analytics.flush();
    expect(small.supabase.calls.map(c => c.events.length)).toEqual([2, 1]);

    const big = setup({ batch: 500 });
    for (let i = 0; i < 150; i++) big.analytics.track('x');
    await big.analytics.flush();
    expect(big.supabase.calls.map(c => c.events.length)).toEqual([100, 50]);
  });

  it('keeps the newest 2000 while offline', async () => {
    const { analytics, supabase, storage } = setup({ maxQueue: 2000 });
    supabase.state.reject = true;
    for (let i = 0; i < 2100; i++) analytics.track('tap', { i });
    await analytics.flush();
    await settle();
    const saved = storage.data.get('analytics:queue') as AnalyticsEvent[];
    expect(saved).toHaveLength(2000);
    expect(saved[0]!.props.i).toBe(100);
    supabase.state.reject = false;
    await analytics.flush();
    expect(sentEvents(supabase.calls)).toHaveLength(2000);
  });

  it('keeps what failed and sends it next time', async () => {
    const { analytics, supabase, storage } = setup();
    supabase.state.fail = true;
    analytics.track('a');
    await analytics.flush();
    expect(supabase.calls).toHaveLength(1);
    expect(storage.data.get('analytics:queue')).toHaveLength(1);
    supabase.state.fail = false;
    await analytics.flush();
    expect(supabase.calls).toHaveLength(2);
    expect(storage.data.get('analytics:queue')).toEqual([]);
  });

  it('flush does nothing without a backend and never rejects', async () => {
    const { analytics, storage } = setup({ getSupabase: () => null });
    analytics.track('a');
    await expect(analytics.flush()).resolves.toBeUndefined();
    expect(storage.data.get('analytics:queue')).toHaveLength(1);
    const broken = setup({ getSupabase: () => Promise.reject(new Error('import failed')) });
    broken.analytics.track('a');
    await expect(broken.analytics.flush()).resolves.toBeUndefined();
  });

  it('shares one send between concurrent flushes', async () => {
    const { analytics, supabase } = setup();
    analytics.track('a');
    await Promise.all([analytics.flush(), analytics.flush(), analytics.flush()]);
    expect(supabase.calls).toHaveLength(1);
  });

  it('sends when the app goes to the background', async () => {
    const { analytics, supabase, life } = setup();
    analytics.track('a');
    await settle();
    life.background();
    await vi.advanceTimersByTimeAsync(0);
    expect(supabase.calls).toHaveLength(1);
  });

  it('drops invalid names and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { analytics, supabase } = setup();
    analytics.track('Bad Name');
    analytics.track('Bad Name');
    analytics.track('ok_name', { big: 'x'.repeat(5000) });
    await analytics.flush();
    expect(sentEvents(supabase.calls).map(e => e.name)).toEqual(['ok_name']);
    expect(sentEvents(supabase.calls)[0]!.props.big).toHaveLength(300);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('cuts platform and language to the server limits', async () => {
    const { analytics, supabase } = setup({ platform: () => 'p'.repeat(50), getLanguage: () => 'es-ES-x-very-long' });
    analytics.track('a');
    await analytics.flush();
    expect(sentEvents(supabase.calls)[0]).toMatchObject({ platform: 'p'.repeat(20), lang: 'es-ES-x-ve' });
  });

  it('fills the version once it is known', async () => {
    let resolveVersion: (v: string) => void = () => undefined;
    const { analytics, supabase } = setup({ getVersion: () => new Promise<string>(r => (resolveVersion = r)) });
    analytics.track('early');
    await settle();
    resolveVersion('2.0.0 (20)');
    await settle();
    analytics.track('late');
    await analytics.flush();
    expect(sentEvents(supabase.calls).map(e => e.v)).toEqual(['2.0.0 (20)', '2.0.0 (20)']);
  });
});

describe('storage', () => {
  it('sends what an earlier run left first, with the same device id', async () => {
    const old: AnalyticsEvent = { name: 'old', at: '2026-11-12T10:00:00.000Z', session: randomUuid(), props: {}, v: '1.0.0 (1)', platform: 'ios', lang: 'es' };
    const device = randomUuid();
    const { analytics, supabase } = setup({}, { 'analytics:queue': [old, { junk: true }], 'analytics:device': device });
    analytics.track('new');
    await analytics.flush();
    expect(sentEvents(supabase.calls).map(e => e.name)).toEqual(['old', 'new']);
    expect(supabase.calls[0]!.device).toBe(device);
  });

  it('creates and keeps a device id', async () => {
    const first = setup();
    const id = await first.analytics.deviceId();
    expect(first.storage.data.get('analytics:device')).toBe(id);
    const second = setup({}, { 'analytics:device': id });
    expect(await second.analytics.deviceId()).toBe(id);
  });

  it('saves the queue on every event, under custom keys too', async () => {
    const { analytics, storage } = setup({ keys: { queue: 'q', device: 'd' } });
    analytics.track('a');
    await settle();
    expect((storage.data.get('q') as AnalyticsEvent[]).map(e => e.name)).toEqual(['a']);
    await analytics.deviceId();
    expect(storage.data.has('d')).toBe(true);
  });

  it('works without storage and with storage that throws', async () => {
    const none = setup({ storage: null });
    none.analytics.track('a');
    await none.analytics.flush();
    expect(none.supabase.calls).toHaveLength(1);
    const broken = setup({ storage: { load: () => Promise.reject(new Error('x')), save: () => { throw new Error('x'); } } });
    broken.analytics.track('a');
    await broken.analytics.flush();
    expect(broken.supabase.calls).toHaveLength(1);
  });

  it('webStorage keeps JSON in a Web Storage', () => {
    const map = new Map<string, string>();
    const store = webStorage({ getItem: k => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) });
    store.save('k', [1, { a: 'b' }]);
    expect(map.get('k')).toBe('[1,{"a":"b"}]');
    expect(store.load('k')).toEqual([1, { a: 'b' }]);
    expect(store.load('none')).toBeNull();
  });
});

describe('enabled flag', () => {
  it('off: drops the queue, stores nothing and sends nothing', async () => {
    const { analytics, supabase, storage } = setup();
    analytics.track('a');
    await settle();
    analytics.setEnabled(false);
    expect(analytics.isEnabled()).toBe(false);
    analytics.track('b');
    await analytics.flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(supabase.client.rpc).not.toHaveBeenCalled();
    expect(storage.data.get('analytics:queue')).toEqual([]);
  });

  it('on again: tracks from then on', async () => {
    const { analytics, supabase } = setup();
    analytics.setEnabled(false);
    analytics.track('lost');
    analytics.setEnabled(true);
    analytics.track('kept');
    await analytics.flush();
    expect(sentEvents(supabase.calls).map(e => e.name)).toEqual(['kept']);
  });

  it('isEnabled() false at start: nothing is sent, even what came before the answer', async () => {
    let answer: (on: boolean) => void = () => undefined;
    const { analytics, supabase, storage } = setup({ isEnabled: () => new Promise<boolean>(r => (answer = r)) }, { 'analytics:queue': [{ name: 'old', at: 'x', session: randomUuid(), props: {}, v: null, platform: 'ios', lang: '' }] });
    analytics.track('early');
    const flushing = analytics.flush();
    await settle();
    expect(supabase.client.rpc).not.toHaveBeenCalled();
    answer(false);
    await flushing;
    await settle();
    expect(supabase.client.rpc).not.toHaveBeenCalled();
    expect(storage.data.get('analytics:queue')).toEqual([]);
    expect(analytics.isEnabled()).toBe(false);
  });

  it('isEnabled() true at start: sends once it answers', async () => {
    const { analytics, supabase } = setup({ isEnabled: async () => true });
    analytics.track('a');
    await analytics.flush();
    expect(supabase.calls).toHaveLength(1);
  });

  it('off while a batch is in flight keeps nothing', async () => {
    const { analytics, supabase, storage } = setup();
    let release: () => void = () => undefined;
    supabase.client.rpc.mockImplementationOnce(() => new Promise(r => (release = () => r({ error: null }))));
    analytics.track('a');
    const flushing = analytics.flush();
    await settle();
    analytics.track('b');
    analytics.setEnabled(false);
    release();
    await flushing;
    await settle();
    expect(storage.data.get('analytics:queue')).toEqual([]);
  });
});

describe('sessions', () => {
  it('keeps the session after a short time in the background', async () => {
    const { analytics, life } = setup();
    const first = analytics.sessionId();
    life.background();
    vi.advanceTimersByTime(29 * 60_000);
    life.foreground();
    expect(analytics.sessionId()).toBe(first);
  });

  it('starts a new session after 30 minutes in the background', async () => {
    const { analytics, supabase, life } = setup();
    analytics.track('before');
    const first = analytics.sessionId();
    life.background();
    vi.advanceTimersByTime(30 * 60_000);
    life.foreground();
    analytics.track('after');
    await analytics.flush();
    expect(analytics.sessionId()).not.toBe(first);
    const [before, after] = sentEvents(supabase.calls);
    expect(before!.session).toBe(first);
    expect(after!.session).toBe(analytics.sessionId());
  });

  it('rotates on the next event when there is no foreground hook', async () => {
    const { analytics, life } = setup({ onForeground: null });
    const first = analytics.sessionId();
    life.background();
    vi.advanceTimersByTime(31 * 60_000);
    analytics.track('back');
    expect(analytics.sessionId()).not.toBe(first);
    const second = analytics.sessionId();
    analytics.track('again');
    expect(analytics.sessionId()).toBe(second);
  });

  it('honours a custom gap', () => {
    const { analytics, life } = setup({ sessionGapMs: 1000 });
    const first = analytics.sessionId();
    life.background();
    vi.advanceTimersByTime(1000);
    life.foreground();
    expect(analytics.sessionId()).not.toBe(first);
  });

  it('dispose removes the lifecycle listeners', () => {
    const { analytics, life } = setup();
    expect(life.handlers.background).toHaveLength(1);
    analytics.dispose();
    return settle().then(() => {
      expect(life.handlers.background).toHaveLength(0);
      expect(life.handlers.foreground).toHaveLength(0);
    });
  });
});

describe('captureErrors', () => {
  const fire = (target: EventTarget, type: string, fields: Record<string, unknown>) => target.dispatchEvent(Object.assign(new Event(type), fields));

  it('reports window errors and unhandled rejections', async () => {
    const { analytics, supabase } = setup();
    const target = new EventTarget();
    analytics.captureErrors({ target, where: () => '/event/:id' });
    fire(target, 'error', { error: new TypeError('x is undefined'), message: 'Uncaught TypeError: x is undefined' });
    fire(target, 'error', { message: 'Script error.' });
    fire(target, 'unhandledrejection', { reason: new Error('network') });
    fire(target, 'unhandledrejection', { reason: 'plain' });
    fire(target, 'unhandledrejection', { reason: { message: 'like an error' } });
    await analytics.flush();
    expect(sentEvents(supabase.calls).map(e => [e.name, e.props])).toEqual([
      ['error', { message: 'TypeError: x is undefined', where: '/event/:id' }],
      ['error', { message: 'Script error.', where: '/event/:id' }],
      ['error', { message: 'Error: network', where: '/event/:id' }],
      ['error', { message: 'plain', where: '/event/:id' }],
      ['error', { message: 'like an error', where: '/event/:id' }],
    ]);
  });

  it('cuts the message to 200 characters', async () => {
    const { analytics, supabase } = setup();
    const target = new EventTarget();
    analytics.captureErrors({ target, where: () => '/' });
    fire(target, 'unhandledrejection', { reason: 'e'.repeat(1000) });
    await analytics.flush();
    expect((sentEvents(supabase.calls)[0]!.props.message as string).length).toBe(200);
  });

  it('counts the same error once per session and at most maxPerSession', async () => {
    const { analytics, supabase, life } = setup();
    const target = new EventTarget();
    analytics.captureErrors({ target, where: () => '/', maxPerSession: 3 });
    for (let i = 0; i < 5; i++) fire(target, 'unhandledrejection', { reason: 'same' });
    for (let i = 0; i < 5; i++) fire(target, 'unhandledrejection', { reason: `other ${i}` });
    await analytics.flush();
    expect(sentEvents(supabase.calls).map(e => e.props.message)).toEqual(['same', 'other 0', 'other 1']);
    life.background();
    vi.advanceTimersByTime(30 * 60_000);
    life.foreground();
    fire(target, 'unhandledrejection', { reason: 'same' });
    await analytics.flush();
    expect(sentEvents(supabase.calls).map(e => e.props.message)).toEqual(['same', 'other 0', 'other 1', 'same']);
  });

  it('stops when asked and is quiet while disabled', async () => {
    const { analytics, supabase } = setup();
    const target = new EventTarget();
    const stop = analytics.captureErrors({ target, where: () => '/' });
    analytics.setEnabled(false);
    fire(target, 'unhandledrejection', { reason: 'off' });
    analytics.setEnabled(true);
    stop();
    fire(target, 'unhandledrejection', { reason: 'stopped' });
    await analytics.flush();
    expect(supabase.client.rpc).not.toHaveBeenCalled();
  });

  it('is a no-op without a window', () => {
    const { analytics } = setup();
    expect(() => analytics.captureErrors()()).not.toThrow();
  });
});
