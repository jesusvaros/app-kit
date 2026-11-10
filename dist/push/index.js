// Push notifications for Capacitor apps: a thin layer over
// @capacitor/push-notifications that keeps the parts every app gets wrong in
// one place.
//
// - The permission is never asked on its own: the app calls
//   requestPermissionWhenUseful() at a moment that makes sense (see
//   createAskPolicy). On Android 13+ that is the POST_NOTIFICATIONS prompt.
// - register() resolves with the token (or rejects), instead of the plugin's
//   fire-and-forget register() plus a listener.
// - FCM rotates tokens: onToken() reports every new token together with the
//   one it replaces, so the backend row can be moved.
// - Taps and foreground messages arrive with `data` already as an object.
//
// On the web and in builds without the plugin everything is a safe no-op:
// the permission reads 'unavailable' and register() rejects with UNAVAILABLE.
import { Capacitor } from '@capacitor/core';
import { PushError } from './types.js';
export { PushError } from './types.js';
export { createAskPolicy } from './askPolicy.js';
export { routeFromData } from './route.js';
const mapPermission = (state) => {
    if (state === 'granted')
        return 'granted';
    if (state === 'denied')
        return 'denied';
    if (state === 'prompt' || state === 'prompt-with-rationale')
        return 'prompt';
    return 'unavailable';
};
const asObject = (value) => {
    if (typeof value === 'string') {
        try {
            return asObject(JSON.parse(value));
        }
        catch {
            return {};
        }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
};
export const toPushMessage = (raw) => {
    const value = asObject(raw);
    const text = (key) => (typeof value[key] === 'string' && value[key] ? value[key] : null);
    return { id: String(value.id ?? ''), title: text('title'), body: text('body'), data: asObject(value.data) };
};
export const createPush = (config = {}) => {
    const registerOn = config.registerOn ?? ['android', 'ios'];
    const timeoutMs = config.registerTimeoutMs ?? 15_000;
    const tokenKey = config.tokenStorageKey ?? 'app-kit.push.token';
    const handlers = { token: new Set(), error: new Set(), received: new Set(), tapped: new Set() };
    const waiters = new Set();
    const storage = () => {
        if (config.storage !== undefined)
            return config.storage;
        try {
            return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
        }
        catch {
            return null;
        }
    };
    let memoryToken = null;
    const readToken = () => {
        try {
            return storage()?.getItem(tokenKey) || memoryToken;
        }
        catch {
            return memoryToken;
        }
    };
    const writeToken = (token) => {
        memoryToken = token;
        try {
            if (token)
                storage()?.setItem(tokenKey, token);
            else
                storage()?.removeItem(tokenKey);
        }
        catch {
            // Memory copy is enough for this session.
        }
    };
    const platform = () => {
        const name = Capacitor.getPlatform();
        return name === 'android' || name === 'ios' ? name : 'web';
    };
    /** The plugin is in this build and this is a phone. */
    const isSupported = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('PushNotifications');
    /** Supported and this platform is set to get a token. */
    const canRegister = () => {
        const current = platform();
        return isSupported() && current !== 'web' && registerOn.includes(current);
    };
    let loading = null;
    const plugin = () => {
        if (!isSupported())
            return Promise.resolve(null);
        loading ??= import('@capacitor/push-notifications')
            .then(module => module.PushNotifications)
            .catch(error => {
            loading = null;
            console.warn('[app-kit] @capacitor/push-notifications is not installed', error);
            return null;
        });
        return loading;
    };
    let listening = null;
    const listen = () => {
        listening ??= plugin().then(async (push) => {
            if (!push)
                return [];
            return Promise.all([
                push.addListener('registration', ({ value }) => {
                    if (!value)
                        return;
                    const previous = readToken();
                    writeToken(value);
                    waiters.forEach(waiter => waiter.resolve(value));
                    waiters.clear();
                    if (previous !== value)
                        handlers.token.forEach(handler => handler({ token: value, previous }));
                }),
                push.addListener('registrationError', ({ error }) => {
                    const failure = new PushError('FAILED', error);
                    waiters.forEach(waiter => waiter.reject(failure));
                    waiters.clear();
                    handlers.error.forEach(handler => handler(failure));
                }),
                push.addListener('pushNotificationReceived', notification => {
                    const message = toPushMessage(notification);
                    handlers.received.forEach(handler => handler(message));
                }),
                push.addListener('pushNotificationActionPerformed', action => {
                    const message = toPushMessage(action.notification);
                    handlers.tapped.forEach(handler => handler(message, action.actionId));
                }),
            ]);
        });
        return listening;
    };
    const subscribe = (kind, handler) => {
        handlers[kind].add(handler);
        void listen();
        return () => {
            handlers[kind].delete(handler);
        };
    };
    const getPermissionState = async () => {
        const push = await plugin();
        if (!push)
            return 'unavailable';
        try {
            return mapPermission((await push.checkPermissions()).receive);
        }
        catch {
            return 'unavailable';
        }
    };
    /**
     * Opens the system prompt only when the answer is still open ('prompt').
     * Granted or denied come back as they are: a denied permission can only be
     * changed in the OS settings. Call it after the user said yes in the app.
     */
    const requestPermissionWhenUseful = async () => {
        const push = await plugin();
        if (!push)
            return 'unavailable';
        const current = await getPermissionState();
        if (current !== 'prompt')
            return current;
        try {
            return mapPermission((await push.requestPermissions()).receive);
        }
        catch {
            return getPermissionState();
        }
    };
    let channelsCreated = false;
    const createChannels = async () => {
        if (channelsCreated || platform() !== 'android' || !config.channels?.length)
            return;
        const push = await plugin();
        if (!push)
            return;
        await Promise.all(config.channels.map(channel => push.createChannel(channel)));
        channelsCreated = true;
    };
    /** Asks the OS for a token (permission must be granted). Resolves with it. */
    const register = async () => {
        if (!canRegister())
            throw new PushError('UNAVAILABLE');
        const push = await plugin();
        if (!push)
            throw new PushError('UNAVAILABLE');
        if ((await getPermissionState()) !== 'granted')
            throw new PushError('NOT_GRANTED');
        await listen();
        await createChannels().catch(error => console.warn('[app-kit] push channels', error));
        return new Promise((resolve, reject) => {
            const waiter = {
                resolve: (token) => {
                    clearTimeout(timer);
                    resolve(token);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            };
            const timer = setTimeout(() => {
                waiters.delete(waiter);
                reject(new PushError('TIMEOUT'));
            }, timeoutMs);
            waiters.add(waiter);
            push.register().catch(error => {
                waiters.delete(waiter);
                waiter.reject(new PushError('FAILED', String(error?.message ?? error)));
            });
        });
    };
    /** Drops the token on the device (FCM deleteToken). The backend row is the app's job. */
    const unregister = async () => {
        const push = await plugin();
        writeToken(null);
        if (push && canRegister())
            await push.unregister().catch(() => undefined);
    };
    return {
        platform,
        isSupported,
        canRegister,
        getPermissionState,
        requestPermissionWhenUseful,
        register,
        unregister,
        createChannels,
        /** Last token this device got, if any. */
        currentToken: readToken,
        /** Attaches the plugin listeners now (call early so a cold-start tap is not missed). */
        listen: () => listen().then(() => undefined),
        /** New token (first one, or an FCM refresh), with the one it replaced. */
        onToken: (handler) => subscribe('token', handler),
        onRegistrationError: (handler) => subscribe('error', handler),
        /** A notification arrived while the app is open (the OS shows nothing). */
        onReceived: (handler) => subscribe('received', handler),
        /** The user tapped a notification (also the one that cold-started the app). */
        onTapped: (handler) => subscribe('tapped', handler),
    };
};
