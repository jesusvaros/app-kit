import { type AnalyticsProps } from './props.js';
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
    rpc: (fn: string, args: {
        p_device: string;
        p_events: AnalyticsEvent[];
    }) => PromiseLike<{
        error: unknown;
    }>;
};
/** A listener subscription: nothing, a function that removes it, or a Capacitor handle (or a promise of one). */
export type AnalyticsUnsubscribe = void | (() => unknown) | {
    remove: () => unknown;
} | Promise<void | (() => unknown) | {
    remove: () => unknown;
}>;
export type AnalyticsLifecycleHook = (callback: () => void) => AnalyticsUnsubscribe;
export type AnalyticsConfig = {
    /** The Supabase client (or null when there is no backend). May be async, e.g. a lazy import. */
    getSupabase: () => AnalyticsRpcClient | null | undefined | Promise<AnalyticsRpcClient | null | undefined>;
    /** RPC name. Default 'track_events'. */
    rpc?: string;
    /** Where the queue and the device id are kept. Without it they live in memory only. */
    storage?: AnalyticsStorage | null;
    /** Storage keys. Default { device: 'analytics:device', queue: 'analytics:queue' } (Lanuki's). */
    keys?: {
        device?: string;
        queue?: string;
    };
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
export declare const screenName: (path: string) => string;
/** Lowercase v4 uuid (what track_events expects as session). */
export declare const randomUuid: () => string;
/** AnalyticsStorage over a Web Storage (localStorage by default), as JSON. */
export declare const webStorage: (storage?: Pick<Storage, "getItem" | "setItem"> | null) => AnalyticsStorage;
export declare const createAnalytics: (config: AnalyticsConfig) => Analytics;
