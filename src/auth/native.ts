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
import { SignInError, type NativeIdentity, type Provider } from './types.js';

export type NativeSignInConfig = {
  google?: {
    /** OAuth client of type "Web": the audience the backend checks. Required on Android and iOS. */
    webClientId?: string;
    /** OAuth client of type "iOS". Required on iOS (plus its URL scheme in Info.plist). */
    iosClientId?: string;
  };
  apple?: {
    /** Native Apple sheet on iOS. Needs the "Sign in with Apple" entitlement. Default: false. */
    enabled?: boolean;
    /** Bundle id of the app (only tells the plugin to set Apple up). */
    bundleId?: string;
  };
  /** Milliseconds before an Android sheet that never showed is given up. Default 8000. */
  sheetTimeoutMs?: number;
  /** Milliseconds before a hanging Google logout (done before each sign-in) is ignored. Default 3000. */
  logoutTimeoutMs?: number;
};

export type NativeSignIn = {
  /** Whether this provider can use the native sheet on this device and build. */
  isAvailable(provider: Provider): boolean;
  /** Opens the sheet. Throws SignInError (CANCELLED when the user closes it). */
  signIn(provider: Provider): Promise<NativeIdentity>;
};

const withTimeout = <T>(promise: Promise<T>, ms: number, code: SignInError['code']) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SignInError(code)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export const isCancellation = (error: unknown) => {
  const text = `${(error as { code?: unknown })?.code ?? ''} ${(error as Error)?.message ?? error}`;
  return /cancel|1001|12501/i.test(text);
};

export const createNativeSignIn = (config: NativeSignInConfig): NativeSignIn => {
  const webClientId = config.google?.webClientId?.trim() || '';
  const iosClientId = config.google?.iosClientId?.trim() || '';
  const appleEnabled = Boolean(config.apple?.enabled);
  const sheetTimeoutMs = config.sheetTimeoutMs ?? 8_000;
  const logoutTimeoutMs = config.logoutTimeoutMs ?? 3_000;

  const platform = () => Capacitor.getPlatform();

  const isAvailable = (provider: Provider) => {
    if (!Capacitor.isNativePlatform()) return false;
    if (provider === 'apple') return appleEnabled && platform() === 'ios';
    if (!webClientId) return false;
    return platform() === 'android' || (platform() === 'ios' && Boolean(iosClientId));
  };

  let initialized: Promise<typeof import('@capgo/capacitor-social-login').SocialLogin> | null = null;
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
    let stop = () => {};
    const promise = new Promise<never>((_, reject) => {
      if (platform() !== 'android') return;
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

  const signIn = async (provider: Provider): Promise<NativeIdentity> => {
    if (!isAvailable(provider)) throw new SignInError('NOT_CONFIGURED');
    const sheet = watchSheet();
    try {
      const SocialLogin = await plugin();
      const nonce = await createNonce();
      if (provider === 'google') {
        // Clearing the last choice is only tidiness: if it fails or hangs, go on.
        await withTimeout(SocialLogin.logout({ provider: 'google' }), logoutTimeoutMs, 'FAILED').catch(() => undefined);
      }
      const login =
        provider === 'google'
          ? // No scopes for Google: the ID token already carries email and name, and
            // on Android custom scopes need changes to MainActivity (the plugin
            // rejects the call otherwise).
            SocialLogin.login({ provider: 'google', options: { nonce: nonce.hashed } })
          : SocialLogin.login({ provider: 'apple', options: { scopes: ['email', 'name'], nonce: nonce.hashed } });
      const response = await Promise.race([login, sheet.promise]);
      const result = response.result as {
        idToken?: string | null;
        profile?: { givenName?: string | null; familyName?: string | null; name?: string | null };
      };
      if (!result?.idToken) throw new SignInError('NO_TOKEN');
      const name =
        [result.profile?.givenName, result.profile?.familyName].filter(Boolean).join(' ').trim() ||
        result.profile?.name?.trim() ||
        null;
      return { provider, idToken: result.idToken, rawNonce: nonce.raw, name };
    } catch (error) {
      if (error instanceof SignInError) throw error;
      const message = String((error as Error)?.message ?? error);
      throw new SignInError(isCancellation(error) ? 'CANCELLED' : 'FAILED', message);
    } finally {
      sheet.stop();
    }
  };

  return { isAvailable, signIn };
};
