// First-party usage analytics for Capacitor + Supabase apps: a port of Lanuki's
// client (ADR-157) without React, Capacitor or i18n imports. Everything the app
// knows (storage, platform, version, language, Supabase, when the app goes to
// the background) is passed in.
//
// - track() returns at once and never throws: events go to a queue that is kept
//   in the app's storage and sent in batches through the `track_events(p_device
//   uuid, p_events jsonb)` RPC, also before signing in (the account comes from
//   the token on the server, never from the phone).
// - A batch is sent 8 s after the last event, as soon as a full batch is
//   queued, when the app goes to the background and whenever the app calls
//   flush(). Failures stay queued; a phone offline for long keeps the newest
//   2000 events.
// - A session id groups what happens in one use of the app: after 30 minutes
//   in the background the next use gets a new one.
// - Off (setEnabled(false), the "share usage" switch): the queue is dropped and
//   nothing else is stored or sent until it is switched on again.

import { isValidEventName, trimProps, type AnalyticsProps } from './props.js';

export { EVENT_NAME, isValidEventName, propsBytes, trimProps } from './props.js';
export type { AnalyticsProps, AnalyticsValue } from './props.js';

/** One queued event: exactly the JSON shape track_events reads from p_events. */
export type AnalyticsEvent = {
  name: string;
  /** ISO time on the phone (the server clamps it to the last 30 days). */
  at: string;
  /** Session uuid (lowercase, 36 characters). */
  session: string;
  props: AnalyticsProps;
  /** App version, e.g. "1.4.0 (52)"; null until known. Max 40 on the server. */
  v: string | null;
  /** 'ios' | 'android' | 'web'… Max 20 on the server. */
  platform: string;
  /** Language code, e.g. 'es'. Max 10 on the server. */
  lang: string;
};

/** JSON values by key. Lanuki: loadJson/saveJson over @capacitor/preferences. */
export type AnalyticsStorage = {
  /** The saved value, or null/undefined when there is none. May throw. */
  load: (key: string) => unknown | Promise<unknown>;
  save: (key: string, value: unknown) => void | Promise<void>;
};

/** What a supabase-js client has that this needs. */
export type AnalyticsRpcClient = {
  // Loose on purpose: a SupabaseClient typed with generated Database types
  // has an rpc() whose parameters are narrowed to that schema's functions,
  // which is not assignable to a (string, object) signature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: (fn: any, args?: any) => PromiseLike<{ error: unknown }>;
};

/** A listener subscription: nothing, a function that removes it, or a Capacitor handle (or a promise of one). */
export type AnalyticsUnsubscribe = void | (() => unknown) | { remove: () => unknown } | Promise<void | (() => unknown) | { remove: () => unknown }>;
export type AnalyticsLifecycleHook = (callback: () => void) => AnalyticsUnsubscribe;

export type AnalyticsConfig = {
  /** The Supabase client (or null when there is no backend). May be async, e.g. a lazy import. */
  getSupabase: () => AnalyticsRpcClient | null | undefined | Promise<AnalyticsRpcClient | null | undefined>;
  /** RPC name. Default 'track_events'. */
  rpc?: string;
  /** Where the queue and the device id are kept. Without it they live in memory only. */
  storage?: AnalyticsStorage | null;
  /** Storage keys. Default { device: 'analytics:device', queue: 'analytics:queue' } (Lanuki's). */
  keys?: { device?: string; queue?: string };
  /** 'ios' | 'android' | 'web', e.g. Capacitor.getPlatform(). */
  platform: string | (() => string);
  /** Read once, at creation. E.g. App.getInfo() → `${version} (${build})`. */
  getVersion?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Read for every event. E.g. () => i18n.language. */
  getLanguage?: () => string | null | undefined;
  /**
   * Whether the person shares usage (the setting). Read once at creation;
   * until it answers nothing is sent, and `false` drops what was queued.
   * Later changes go through setEnabled(). Default: on.
   */
  isEnabled?: () => boolean | Promise<boolean>;
  /** Milliseconds after the last event before sending. Default 8000. */
  flushAfterMs?: number;
  /** Events kept while offline (the newest). Default 2000. */
  maxQueue?: number;
  /** Events per RPC call. Default 100, which is also the server's limit. */
  batch?: number;
  /** Time in the background that starts a new session. Default 30 minutes. */
  sessionGapMs?: number;
  /** Size limit for the props of one event, in bytes of JSON. Default 1800 (the table allows < 2048 of jsonb). */
  maxPropsBytes?: number;
  /**
   * Subscribe to the app going to the background: the queue is sent then.
   * Capacitor: `cb => App.addListener('pause', cb)`. Default: the page becoming
   * hidden (document visibilitychange / pagehide) when there is a document.
   * null: none.
   */
  onBackground?: AnalyticsLifecycleHook | null;
  /** Subscribe to the app coming back. Capacitor: `cb => App.addListener('resume', cb)`. Default: the page becoming visible. */
  onForeground?: AnalyticsLifecycleHook | null;
};

export type CaptureErrorsOptions = {
  /** Where it happened. Default: the current screen, screenName(location.pathname). */
  where?: () => string;
  /** Default: window. */
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  /** At most this many error events per session (the same message and place counts once). Default 20. */
  maxPerSession?: number;
};

export type Analytics = {
  /** Something happened. Returns at once; the event is sent later. Invalid names are dropped. */
  track: (name: string, props?: Record<string, unknown>) => void;
  /** Sends what is queued. Never rejects; failures stay queued. */
  flush: () => Promise<void>;
  /** The setting changed. Off drops the queue and stops sending. */
  setEnabled: (on: boolean) => void;
  isEnabled: () => boolean;
  /** A route as an event prop: ids, handles and numbers out, so screens group together. */
  screenName: (path: string) => string;
  /** window error / unhandledrejection → `error { message ≤ 200, where }`. Returns the function that stops it. */
  captureErrors: (options?: CaptureErrorsOptions) => () => void;
  /** The current session id. */
  sessionId: () => string;
  /** This install's random id (created and stored on first use). */
  deviceId: () => Promise<string>;
  /** Removes the listeners and the timer. */
  dispose: () => void;
};

/** A route as an event: uuids, @handles and numeric segments out; at most 80 characters. */
export const screenName = (path: string): string =>
  path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/@[^/]+/, '/@:handle')
    .replace(/\/\d+(?=\/|$)/g, '/:n')
    .slice(0, 80) || '/';

/** Lowercase v4 uuid (what track_events expects as session). */
export const randomUuid = (): string => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().toLowerCase();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** AnalyticsStorage over a Web Storage (localStorage by default), as JSON. */
export const webStorage = (storage?: Pick<Storage, 'getItem' | 'setItem'> | null): AnalyticsStorage => {
  const target = () => storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  return {
    load: key => {
      const raw = target()?.getItem(key);
      return raw ? JSON.parse(raw) : null;
    },
    save: (key, value) => target()?.setItem(key, JSON.stringify(value)),
  };
};

const isEvent = (value: unknown): value is AnalyticsEvent => {
  const e = value as AnalyticsEvent;
  return !!e && typeof e === 'object' && isValidEventName(e.name) && typeof e.at === 'string' && typeof e.session === 'string';
};

const removeSubscription = (subscription: AnalyticsUnsubscribe) => {
  void Promise.resolve(subscription)
    .then(handle => {
      if (typeof handle === 'function') handle();
      else if (handle && typeof handle === 'object' && typeof handle.remove === 'function') return handle.remove();
    })
    .catch(() => undefined);
};

const pageLifecycle = (state: 'hidden' | 'visible'): AnalyticsLifecycleHook | null => {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return null;
  return callback => {
    const onVisibility = () => {
      if (document.visibilityState === state) callback();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const onPageHide = () => callback();
    if (state === 'hidden' && typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (state === 'hidden' && typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
    };
  };
};

const messageOf = (value: unknown): string => {
  if (value instanceof Error) return value.message ? `${value.name}: ${value.message}` : value.name;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') return (value as { message: string }).message;
  try {
    return String(value);
  } catch {
    return 'unknown';
  }
};

export const createAnalytics = (config: AnalyticsConfig): Analytics => {
  const rpc = config.rpc ?? 'track_events';
  const deviceKey = config.keys?.device ?? 'analytics:device';
  const queueKey = config.keys?.queue ?? 'analytics:queue';
  const flushAfterMs = config.flushAfterMs ?? 8000;
  const maxQueue = Math.max(1, config.maxQueue ?? 2000);
  const batchSize = Math.min(100, Math.max(1, config.batch ?? 100));
  const sessionGapMs = config.sessionGapMs ?? 30 * 60_000;
  const maxPropsBytes = config.maxPropsBytes ?? 1800;
  const storage = config.storage ?? null;

  let session = randomUuid();
  let enabled = true;
  let version: string | null = null;
  let queue: AnalyticsEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending: Promise<void> | null = null;
  let backgroundAt: number | null = null;
  let device: string | null = null;
  const versionless = new Set<AnalyticsEvent>();
  const sessionListeners = new Set<() => void>();
  const subscriptions: AnalyticsUnsubscribe[] = [];

  const load = async (key: string): Promise<unknown> => {
    if (!storage) return null;
    try {
      return await storage.load(key);
    } catch {
      return null;
    }
  };
  const save = async (key: string, value: unknown) => {
    if (!storage) return;
    try {
      await storage.save(key, value);
    } catch {
      // Kept in memory; saved with the next change.
    }
  };

  // What was left from earlier runs goes first; what this run tracked meanwhile, after.
  const loaded = load(queueKey).then(saved => {
    if (!enabled) return;
    const earlier = Array.isArray(saved) ? saved.filter(isEvent) : [];
    queue = [...earlier, ...queue].slice(-maxQueue);
  });

  const enabledKnown = Promise.resolve()
    .then(() => (config.isEnabled ? config.isEnabled() : true))
    .then(
      on => {
        if (on === false) setEnabled(false);
      },
      () => undefined,
    );

  const ready = Promise.all([loaded, enabledKnown]);

  void Promise.resolve()
    .then(() => config.getVersion?.())
    .then(
      value => {
        version = value ? String(value) : null;
        versionless.forEach(event => {
          event.v = version;
        });
        versionless.clear();
      },
      () => versionless.clear(),
    );

  const persist = () => void ready.then(() => save(queueKey, enabled ? queue : []));

  const platform = () => {
    try {
      return typeof config.platform === 'function' ? config.platform() : config.platform;
    } catch {
      return '';
    }
  };
  const language = () => {
    try {
      return config.getLanguage?.() ?? '';
    } catch {
      return '';
    }
  };

  const newSession = () => {
    session = randomUuid();
    sessionListeners.forEach(listener => listener());
  };
  const rotateIfAway = () => {
    if (backgroundAt !== null && Date.now() - backgroundAt >= sessionGapMs) {
      newSession();
      return true;
    }
    return false;
  };

  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, ms);
  };

  const warned = new Set<string>();
  const track: Analytics['track'] = (name, props = {}) => {
    try {
      if (!enabled) return;
      if (!isValidEventName(name)) {
        if (!warned.has(String(name))) {
          warned.add(String(name));
          console.warn(`[app-kit] analytics: invalid event name "${String(name)}" (must match ^[a-z][a-z0-9_]{0,59}$)`);
        }
        return;
      }
      // An event while still in the background (a finished upload…) after a long gap starts a new session.
      if (rotateIfAway()) backgroundAt = Date.now();
      const event: AnalyticsEvent = {
        name,
        at: new Date().toISOString(),
        session,
        props: trimProps(props, maxPropsBytes),
        v: version,
        platform: platform().slice(0, 20),
        lang: language().slice(0, 10),
      };
      if (version === null) versionless.add(event);
      queue = [...queue, event].slice(-maxQueue);
      persist();
      schedule(queue.length >= batchSize ? 0 : flushAfterMs);
    } catch {
      // Analytics never breaks the app.
    }
  };

  const deviceId = async () => {
    if (device) return device;
    const known = await load(deviceKey);
    if (device) return device;
    if (typeof known === 'string' && /^[0-9a-f-]{36}$/i.test(known)) {
      device = known;
      return device;
    }
    device = randomUuid();
    await save(deviceKey, device);
    return device;
  };

  const send = async () => {
    try {
      await ready;
      if (!enabled || !queue.length) return;
      const supabase = await config.getSupabase();
      if (!supabase) return;
      const id = await deviceId();
      while (enabled && queue.length) {
        const batch = queue.slice(0, batchSize);
        const { error } = await supabase.rpc(rpc, { p_device: id, p_events: batch });
        if (error) return;
        // Off while sending: the queue is already empty.
        if (!enabled) return;
        const sent = new Set(batch);
        queue = queue.filter(event => !sent.has(event));
        await save(queueKey, queue);
      }
    } catch {
      // Offline or no backend: tried again next time.
    }
  };

  const flush = (): Promise<void> => {
    if (!enabled) return Promise.resolve();
    sending ??= send().finally(() => {
      sending = null;
    });
    return sending;
  };

  function setEnabled(on: boolean) {
    enabled = on;
    if (!on) {
      if (timer) clearTimeout(timer);
      timer = null;
      queue = [];
      versionless.clear();
      void save(queueKey, []);
    }
  }

  const onBackground = config.onBackground === undefined ? pageLifecycle('hidden') : config.onBackground;
  const onForeground = config.onForeground === undefined ? pageLifecycle('visible') : config.onForeground;
  const subscribe = (hook: AnalyticsLifecycleHook | null, callback: () => void) => {
    if (!hook) return;
    try {
      subscriptions.push(hook(callback));
    } catch {
      // No lifecycle: flushes on the timer and when the app asks.
    }
  };
  subscribe(onBackground, () => {
    backgroundAt ??= Date.now();
    void flush();
  });
  subscribe(onForeground, () => {
    rotateIfAway();
    backgroundAt = null;
  });

  const captureErrors: Analytics['captureErrors'] = (options = {}) => {
    const target = options.target === undefined ? (typeof window !== 'undefined' ? window : null) : options.target;
    if (!target) return () => undefined;
    const maxPerSession = options.maxPerSession ?? 20;
    let seen = new Set<string>();
    const resetSeen = () => {
      seen = new Set();
    };
    sessionListeners.add(resetSeen);
    const where = () => {
      try {
        if (options.where) return options.where();
        return typeof location !== 'undefined' ? screenName(location.pathname) : '';
      } catch {
        return '';
      }
    };
    const report = (raw: unknown) => {
      const message = (messageOf(raw) || 'unknown').slice(0, 200);
      const place = where().slice(0, 80);
      const key = `${message}\n${place}`;
      if (seen.has(key) || seen.size >= maxPerSession) return;
      seen.add(key);
      track('error', { message, where: place });
    };
    const onError = (event: Event) => {
      const e = event as ErrorEvent;
      report(e.error ?? e.message);
    };
    const onRejection = (event: Event) => report((event as PromiseRejectionEvent).reason);
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
    return () => {
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onRejection);
      sessionListeners.delete(resetSeen);
    };
  };

  return {
    track,
    flush,
    setEnabled,
    isEnabled: () => enabled,
    screenName,
    captureErrors,
    sessionId: () => session,
    deviceId,
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      subscriptions.splice(0).forEach(removeSubscription);
      sessionListeners.clear();
    },
  };
};
