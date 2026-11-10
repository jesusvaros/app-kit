// When to offer notifications. Never at app start: the app calls `decide`
// right after the user did something a notification would help with (said
// they are going to a concert, followed someone, reserved something).
//
// - granted → register silently, no sheet.
// - denied  → nothing (only the OS settings can change it; show that in the
//   app's settings screen instead).
// - prompt  → show the app's own explainer first, unless the user said «not
//   now» less than `cooldownDays` ago. Only a «yes» there opens the system
//   prompt, so the one-shot system dialog is never wasted.
const defaultStorage = () => {
    try {
        return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
    }
    catch {
        return null;
    }
};
export const createAskPolicy = (config = {}) => {
    const cooldownMs = (config.cooldownDays ?? 14) * 24 * 60 * 60 * 1000;
    const key = config.storageKey ?? 'app-kit.push.declinedAt';
    const storage = () => (config.storage === undefined ? defaultStorage() : config.storage);
    const now = config.now ?? (() => Date.now());
    const declinedAt = () => {
        try {
            const value = Number(storage()?.getItem(key));
            return Number.isFinite(value) && value > 0 ? value : null;
        }
        catch {
            return null;
        }
    };
    const inCooldown = () => {
        const at = declinedAt();
        return at !== null && now() - at < cooldownMs;
    };
    const decide = (permission) => {
        if (permission === 'granted')
            return 'register';
        if (permission !== 'prompt')
            return 'skip';
        return inCooldown() ? 'skip' : 'explain';
    };
    /** The user picked «not now» in the explainer (or dismissed it). */
    const declined = () => {
        try {
            storage()?.setItem(key, String(now()));
        }
        catch {
            // No storage: at worst the explainer shows again next time.
        }
    };
    /** The user said yes (or turned notifications on in settings): forget the «not now». */
    const reset = () => {
        try {
            storage()?.removeItem(key);
        }
        catch {
            // Nothing to forget.
        }
    };
    return { decide, declined, reset, declinedAt, inCooldown };
};
