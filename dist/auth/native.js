// Native Google / Apple sign-in for Capacitor apps: the system account sheet
// (Credential Manager on Android, Google and Apple sheets on iOS) instead of a
// browser tab. Returns an ID token plus the raw nonce for the backend to check.
//
// Lessons carried over from the apps that already ship this:
// - Credential Manager can leave a call unanswered for ever: logout and the
//   sheet both have a time limit, and on Android a sheet that never shows
//   (the app never goes to "pause") is reported as SHEET_TIMEOUT.
// - The provider gets SHA-256(nonce); the backend gets the raw one.
// - Apple sends the user's name only on the very first sign-in.
import { Capacitor } from '@capacitor/core';
import { createNonce } from './nonce.js';
import { SignInError } from './types.js';
const withTimeout = (promise, ms, code) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SignInError(code)), ms);
    promise.then(value => {
        clearTimeout(timer);
        resolve(value);
    }, error => {
        clearTimeout(timer);
        reject(error);
    });
});
export const isCancellation = (error) => {
    const text = `${error?.code ?? ''} ${error?.message ?? error}`;
    return /cancel|1001|12501/i.test(text);
};
export const createNativeSignIn = (config) => {
    const webClientId = config.google?.webClientId?.trim() || '';
    const iosClientId = config.google?.iosClientId?.trim() || '';
    const appleEnabled = Boolean(config.apple?.enabled);
    const sheetTimeoutMs = config.sheetTimeoutMs ?? 8_000;
    const logoutTimeoutMs = config.logoutTimeoutMs ?? 3_000;
    const platform = () => Capacitor.getPlatform();
    const isAvailable = (provider) => {
        if (!Capacitor.isNativePlatform())
            return false;
        if (provider === 'apple')
            return appleEnabled && platform() === 'ios';
        if (!webClientId)
            return false;
        return platform() === 'android' || (platform() === 'ios' && Boolean(iosClientId));
    };
    let initialized = null;
    const plugin = () => {
        initialized ??= import('@capgo/capacitor-social-login')
            .then(async ({ SocialLogin }) => {
            await SocialLogin.initialize({
                google: webClientId
                    ? {
                        webClientId,
                        iOSClientId: iosClientId || undefined,
                        // The ID token must be issued for the web client on iOS too.
                        iOSServerClientId: webClientId,
                        mode: 'online',
                    }
                    : undefined,
                apple: appleEnabled && platform() === 'ios' ? { clientId: config.apple?.bundleId || 'app' } : undefined,
            });
            return SocialLogin;
        })
            .catch(error => {
            initialized = null;
            throw error;
        });
        return initialized;
    };
    // Android only: rejects if the sheet has not shown (the app never paused) in time.
    const watchSheet = () => {
        let stop = () => { };
        const promise = new Promise((_, reject) => {
            if (platform() !== 'android')
                return;
            const timer = setTimeout(() => reject(new SignInError('SHEET_TIMEOUT')), sheetTimeoutMs);
            const listener = import('@capacitor/app')
                .then(({ App }) => App.addListener('pause', () => clearTimeout(timer)))
                .catch(() => null);
            stop = () => {
                clearTimeout(timer);
                void listener.then(handle => handle?.remove());
            };
        });
        return { promise, stop };
    };
    const signIn = async (provider) => {
        if (!isAvailable(provider))
            throw new SignInError('NOT_CONFIGURED');
        const sheet = watchSheet();
        try {
            const SocialLogin = await plugin();
            const nonce = await createNonce();
            if (provider === 'google') {
                // Clearing the last choice is only tidiness: if it fails or hangs, go on.
                await withTimeout(SocialLogin.logout({ provider: 'google' }), logoutTimeoutMs, 'FAILED').catch(() => undefined);
            }
            const login = provider === 'google'
                ? // No scopes for Google: the ID token already carries email and name, and
                    // on Android custom scopes need changes to MainActivity (the plugin
                    // rejects the call otherwise).
                    SocialLogin.login({ provider: 'google', options: { nonce: nonce.hashed } })
                : SocialLogin.login({ provider: 'apple', options: { scopes: ['email', 'name'], nonce: nonce.hashed } });
            const response = await Promise.race([login, sheet.promise]);
            const result = response.result;
            if (!result?.idToken)
                throw new SignInError('NO_TOKEN');
            const name = [result.profile?.givenName, result.profile?.familyName].filter(Boolean).join(' ').trim() ||
                result.profile?.name?.trim() ||
                null;
            return { provider, idToken: result.idToken, rawNonce: nonce.raw, name };
        }
        catch (error) {
            if (error instanceof SignInError)
                throw error;
            const message = String(error?.message ?? error);
            throw new SignInError(isCancellation(error) ? 'CANCELLED' : 'FAILED', message);
        }
        finally {
            sheet.stop();
        }
    };
    return { isAvailable, signIn };
};
