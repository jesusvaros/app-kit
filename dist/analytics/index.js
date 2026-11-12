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
import { isValidEventName, trimProps } from './props.js';
export { EVENT_NAME, isValidEventName, propsBytes, trimProps } from './props.js';
/** A route as an event: uuids, @handles and numeric segments out; at most 80 characters. */
export const screenName = (path) => path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/@[^/]+/, '/@:handle')
    .replace(/\/\d+(?=\/|$)/g, '/:n')
    .slice(0, 80) || '/';
/** Lowercase v4 uuid (what track_events expects as session). */
export const randomUuid = () => {
    const c = globalThis.crypto;
    if (c?.randomUUID)
        return c.randomUUID().toLowerCase();
    const bytes = new Uint8Array(16);
    if (c?.getRandomValues)
        c.getRandomValues(bytes);
    else
        for (let i = 0; i < 16; i++)
            bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
/** AnalyticsStorage over a Web Storage (localStorage by default), as JSON. */
export const webStorage = (storage) => {
    const target = () => storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    return {
        load: key => {
            const raw = target()?.getItem(key);
            return raw ? JSON.parse(raw) : null;
        },
        save: (key, value) => target()?.setItem(key, JSON.stringify(value)),
    };
};
const isEvent = (value) => {
    const e = value;
    return !!e && typeof e === 'object' && isValidEventName(e.name) && typeof e.at === 'string' && typeof e.session === 'string';
};
const removeSubscription = (subscription) => {
    void Promise.resolve(subscription)
        .then(handle => {
        if (typeof handle === 'function')
            handle();
        else if (handle && typeof handle === 'object' && typeof handle.remove === 'function')
            return handle.remove();
    })
        .catch(() => undefined);
};
const pageLifecycle = (state) => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function')
        return null;
    return callback => {
        const onVisibility = () => {
            if (document.visibilityState === state)
                callback();
        };
        document.addEventListener('visibilitychange', onVisibility);
        const onPageHide = () => callback();
        if (state === 'hidden' && typeof window !== 'undefined')
            window.addEventListener('pagehide', onPageHide);
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            if (state === 'hidden' && typeof window !== 'undefined')
                window.removeEventListener('pagehide', onPageHide);
        };
    };
};
const messageOf = (value) => {
    if (value instanceof Error)
        return value.message ? `${value.name}: ${value.message}` : value.name;
    if (typeof value === 'string')
        return value;
    if (value && typeof value === 'object' && typeof value.message === 'string')
        return value.message;
    try {
        return String(value);
    }
    catch {
        return 'unknown';
    }
};
export const createAnalytics = (config) => {
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
    let version = null;
    let queue = [];
    let timer = null;
    let sending = null;
    let backgroundAt = null;
    let device = null;
    const versionless = new Set();
    const sessionListeners = new Set();
    const subscriptions = [];
    const load = async (key) => {
        if (!storage)
            return null;
        try {
            return await storage.load(key);
        }
        catch {
            return null;
        }
    };
    const save = async (key, value) => {
        if (!storage)
            return;
        try {
            await storage.save(key, value);
        }
        catch {
            // Kept in memory; saved with the next change.
        }
    };
    // What was left from earlier runs goes first; what this run tracked meanwhile, after.
    const loaded = load(queueKey).then(saved => {
        if (!enabled)
            return;
        const earlier = Array.isArray(saved) ? saved.filter(isEvent) : [];
        queue = [...earlier, ...queue].slice(-maxQueue);
    });
    const enabledKnown = Promise.resolve()
        .then(() => (config.isEnabled ? config.isEnabled() : true))
        .then(on => {
        if (on === false)
            setEnabled(false);
    }, () => undefined);
    const ready = Promise.all([loaded, enabledKnown]);
    void Promise.resolve()
        .then(() => config.getVersion?.())
        .then(value => {
        version = value ? String(value) : null;
        versionless.forEach(event => {
            event.v = version;
        });
        versionless.clear();
    }, () => versionless.clear());
    const persist = () => void ready.then(() => save(queueKey, enabled ? queue : []));
    const platform = () => {
        try {
            return typeof config.platform === 'function' ? config.platform() : config.platform;
        }
        catch {
            return '';
        }
    };
    const language = () => {
        try {
            return config.getLanguage?.() ?? '';
        }
        catch {
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
    const schedule = (ms) => {
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            void flush();
        }, ms);
    };
    const warned = new Set();
    const track = (name, props = {}) => {
        try {
            if (!enabled)
                return;
            if (!isValidEventName(name)) {
                if (!warned.has(String(name))) {
                    warned.add(String(name));
                    console.warn(`[app-kit] analytics: invalid event name "${String(name)}" (must match ^[a-z][a-z0-9_]{0,59}$)`);
                }
                return;
            }
            // An event while still in the background (a finished upload…) after a long gap starts a new session.
            if (rotateIfAway())
                backgroundAt = Date.now();
            const event = {
                name,
                at: new Date().toISOString(),
                session,
                props: trimProps(props, maxPropsBytes),
                v: version,
                platform: platform().slice(0, 20),
                lang: language().slice(0, 10),
            };
            if (version === null)
                versionless.add(event);
            queue = [...queue, event].slice(-maxQueue);
            persist();
            schedule(queue.length >= batchSize ? 0 : flushAfterMs);
        }
        catch {
            // Analytics never breaks the app.
        }
    };
    const deviceId = async () => {
        if (device)
            return device;
        const known = await load(deviceKey);
        if (device)
            return device;
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
            if (!enabled || !queue.length)
                return;
            const supabase = await config.getSupabase();
            if (!supabase)
                return;
            const id = await deviceId();
            while (enabled && queue.length) {
                const batch = queue.slice(0, batchSize);
                const { error } = await supabase.rpc(rpc, { p_device: id, p_events: batch });
                if (error)
                    return;
                // Off while sending: the queue is already empty.
                if (!enabled)
                    return;
                const sent = new Set(batch);
                queue = queue.filter(event => !sent.has(event));
                await save(queueKey, queue);
            }
        }
        catch {
            // Offline or no backend: tried again next time.
        }
    };
    const flush = () => {
        if (!enabled)
            return Promise.resolve();
        sending ??= send().finally(() => {
            sending = null;
        });
        return sending;
    };
    function setEnabled(on) {
        enabled = on;
        if (!on) {
            if (timer)
                clearTimeout(timer);
            timer = null;
            queue = [];
            versionless.clear();
            void save(queueKey, []);
        }
    }
    const onBackground = config.onBackground === undefined ? pageLifecycle('hidden') : config.onBackground;
    const onForeground = config.onForeground === undefined ? pageLifecycle('visible') : config.onForeground;
    const subscribe = (hook, callback) => {
        if (!hook)
            return;
        try {
            subscriptions.push(hook(callback));
        }
        catch {
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
    const captureErrors = (options = {}) => {
        const target = options.target === undefined ? (typeof window !== 'undefined' ? window : null) : options.target;
        if (!target)
            return () => undefined;
        const maxPerSession = options.maxPerSession ?? 20;
        let seen = new Set();
        const resetSeen = () => {
            seen = new Set();
        };
        sessionListeners.add(resetSeen);
        const where = () => {
            try {
                if (options.where)
                    return options.where();
                return typeof location !== 'undefined' ? screenName(location.pathname) : '';
            }
            catch {
                return '';
            }
        };
        const report = (raw) => {
            const message = (messageOf(raw) || 'unknown').slice(0, 200);
            const place = where().slice(0, 80);
            const key = `${message}\n${place}`;
            if (seen.has(key) || seen.size >= maxPerSession)
                return;
            seen.add(key);
            track('error', { message, where: place });
        };
        const onError = (event) => {
            const e = event;
            report(e.error ?? e.message);
        };
        const onRejection = (event) => report(event.reason);
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
            if (timer)
                clearTimeout(timer);
            timer = null;
            subscriptions.splice(0).forEach(removeSubscription);
            sessionListeners.clear();
        },
    };
};
