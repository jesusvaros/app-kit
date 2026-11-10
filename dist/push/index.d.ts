import { PushError, type PushChannel, type PushMessage, type PushPermission, type PushPlatform, type PushTokenChange } from './types.js';
export { PushError } from './types.js';
export type { PushChannel, PushErrorCode, PushMessage, PushPermission, PushPlatform, PushTokenChange } from './types.js';
export { createAskPolicy } from './askPolicy.js';
export type { AskDecision, AskPolicy, AskPolicyConfig } from './askPolicy.js';
export { routeFromData } from './route.js';
type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type PushConfig = {
    /** Platforms that ask for a token. Default ['android', 'ios']; e.g. ['android'] until APNs is set up. */
    registerOn?: Array<Exclude<PushPlatform, 'web'>>;
    /** Android channels, created before the first registration. */
    channels?: PushChannel[];
    /** Milliseconds register() waits for the token. Default 15000. */
    registerTimeoutMs?: number;
    /** Where the last token is kept (to spot refreshes and to remove it on sign-out). Default 'app-kit.push.token'. */
    tokenStorageKey?: string;
    /** Default: window.localStorage when there is one. */
    storage?: KeyValueStorage | null;
};
export declare const toPushMessage: (raw: unknown) => PushMessage;
export declare const createPush: (config?: PushConfig) => {
    platform: () => PushPlatform;
    isSupported: () => boolean;
    canRegister: () => boolean;
    getPermissionState: () => Promise<PushPermission>;
    requestPermissionWhenUseful: () => Promise<PushPermission>;
    register: () => Promise<string>;
    unregister: () => Promise<void>;
    createChannels: () => Promise<void>;
    /** Last token this device got, if any. */
    currentToken: () => string | null;
    /** Attaches the plugin listeners now (call early so a cold-start tap is not missed). */
    listen: () => Promise<undefined>;
    /** New token (first one, or an FCM refresh), with the one it replaced. */
    onToken: (handler: (change: PushTokenChange) => void) => () => void;
    onRegistrationError: (handler: (error: PushError) => void) => () => void;
    /** A notification arrived while the app is open (the OS shows nothing). */
    onReceived: (handler: (message: PushMessage) => void) => () => void;
    /** The user tapped a notification (also the one that cold-started the app). */
    onTapped: (handler: (message: PushMessage, actionId: string) => void) => () => void;
};
export type Push = ReturnType<typeof createPush>;
