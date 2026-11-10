import type { PushPermission } from './types.js';
export type AskDecision = 'register' | 'explain' | 'skip';
type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type AskPolicyConfig = {
    /** Default 14. */
    cooldownDays?: number;
    /** Where the last «not now» is kept. Default 'app-kit.push.declinedAt'. */
    storageKey?: string;
    /** Default: window.localStorage when there is one. */
    storage?: KeyValueStorage | null;
    now?: () => number;
};
export declare const createAskPolicy: (config?: AskPolicyConfig) => {
    decide: (permission: PushPermission) => AskDecision;
    declined: () => void;
    reset: () => void;
    declinedAt: () => number | null;
    inCooldown: () => boolean;
};
export type AskPolicy = ReturnType<typeof createAskPolicy>;
export {};
