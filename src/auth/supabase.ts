// Supabase side of the shared login: which providers to show, sign in with
// the native sheet (signInWithIdToken) or the browser, and read the deep link
// the browser flow comes back with in the app.

import type { SupabaseClient } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import type { NativeSignIn } from './native.js';
import { SignInError, type Provider } from './types.js';

export type SupabaseAuthOptions = {
  supabase: SupabaseClient<any, any, any>;
  /** Project URL and publishable (anon) key: used to read which providers are switched on. */
  url: string;
  publishableKey: string;
  native?: NativeSignIn;
  /**
   * Browser flow inside the app (plan B, and Apple on Android): the custom
   * scheme Supabase sends the user back to, e.g. com.example.app://auth/callback,
   * and how to open the provider page (e.g. Browser.open from @capacitor/browser).
   * Without both, providers without a native sheet are hidden in the app.
   */
  appCallbackUrl?: string;
  openInAppBrowser?: (url: string) => Promise<void>;
  /** Where the web comes back to after Google/Apple. Default: origin + returnPath (or the current path). */
  webRedirectUrl?: (returnPath?: string) => string;
};

export type SignInOutcome =
  /** Session stored: onAuthStateChange fires. */
  | 'signed-in'
  /** Left for the provider page; the session comes back by redirect or deep link. */
  | 'redirecting'
  | 'cancelled';

export type SignInOptions = {
  /** Web only: path to come back to after the provider page. */
  returnPath?: string;
  /** Web only: runs before the page is left (save what the user was doing). */
  beforeRedirect?: () => Promise<void> | void;
};

export type CallbackResult =
  | { kind: 'signed-in' }
  | { kind: 'recovery' }
  | { kind: 'error'; message: string }
  | { kind: 'ignored' };

const safePath = (path: string | undefined) =>
  path && path.startsWith('/') && !path.startsWith('//') ? path : undefined;

export const createSupabaseAuth = (options: SupabaseAuthOptions) => {
  const { supabase, native } = options;
  const isNative = () => Capacitor.isNativePlatform();
  const canUseAppBrowser = () => Boolean(options.appCallbackUrl && options.openInAppBrowser);

  const webRedirectUrl = (returnPath?: string) =>
    options.webRedirectUrl?.(returnPath) ??
    `${window.location.origin}${safePath(returnPath) ?? window.location.pathname}`;

  /** Providers switched on in Supabase that can also work on this device. */
  const availableProviders = async (): Promise<Record<Provider, boolean>> => {
    const none = { google: false, apple: false };
    if (!options.url || !options.publishableKey) return none;
    try {
      const response = await fetch(`${options.url}/auth/v1/settings`, { headers: { apikey: options.publishableKey } });
      if (!response.ok) return none;
      const { external } = (await response.json()) as { external?: Partial<Record<Provider, boolean>> };
      const works = (provider: Provider) =>
        !isNative() || Boolean(native?.isAvailable(provider)) || canUseAppBrowser();
      return {
        google: Boolean(external?.google) && works('google'),
        apple: Boolean(external?.apple) && works('apple'),
      };
    } catch {
      return none;
    }
  };

  const signInWithBrowser = async (provider: Provider, signInOptions: SignInOptions): Promise<SignInOutcome> => {
    if (isNative()) {
      if (!canUseAppBrowser()) throw new SignInError('NOT_CONFIGURED');
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: options.appCallbackUrl, skipBrowserRedirect: true },
      });
      if (error) throw error;
      if (!data?.url) throw new SignInError('FAILED', 'Supabase no devolvió la URL del proveedor.');
      await options.openInAppBrowser!(data.url);
      return 'redirecting';
    }
    await signInOptions.beforeRedirect?.();
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: webRedirectUrl(signInOptions.returnPath) },
    });
    if (error) throw error;
    return 'redirecting';
  };

  /**
   * Native sheet when it is set up for this provider; otherwise (or if the
   * sheet breaks for a reason other than the user closing it) the browser.
   */
  const signIn = async (provider: Provider, signInOptions: SignInOptions = {}): Promise<SignInOutcome> => {
    if (native?.isAvailable(provider)) {
      try {
        const identity = await native.signIn(provider);
        const { error } = await supabase.auth.signInWithIdToken({
          provider,
          token: identity.idToken,
          nonce: identity.rawNonce,
        });
        if (error) throw error;
        if (identity.name) {
          await supabase.auth
            .updateUser({ data: { full_name: identity.name, display_name: identity.name } })
            .catch(() => undefined);
        }
        return 'signed-in';
      } catch (error) {
        if (error instanceof SignInError && error.code === 'CANCELLED') return 'cancelled';
        if (!canUseAppBrowser()) throw error;
        console.warn(`[app-kit] Native ${provider} sign-in failed, using the browser`, error);
      }
    }
    return signInWithBrowser(provider, signInOptions);
  };

  /**
   * Handles appCallbackUrl#access_token=…&refresh_token=…&type=… (implicit
   * flow), …?code=… (PKCE) and Supabase's error redirects. Call it from the
   * app's appUrlOpen listener and close the in-app browser.
   */
  const handleCallbackUrl = async (rawUrl: string): Promise<CallbackResult> => {
    const base = options.appCallbackUrl;
    if (!base || !rawUrl.startsWith(base)) return { kind: 'ignored' };

    const url = new URL(rawUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, 'https://callback/'));
    const params = new URLSearchParams(url.hash.replace(/^#/, ''));
    url.searchParams.forEach((value, key) => params.set(key, value));

    const failure = params.get('error_description') || params.get('error');
    if (failure) return { kind: 'error', message: failure.replace(/\+/g, ' ') };

    const code = params.get('code');
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const { error } = code
      ? await supabase.auth.exchangeCodeForSession(code)
      : accessToken && refreshToken
        ? await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
        : { error: new Error('El enlace no trae sesión.') };
    if (error) return { kind: 'error', message: error.message };
    return params.get('type') === 'recovery' ? { kind: 'recovery' } : { kind: 'signed-in' };
  };

  return { availableProviders, signIn, handleCallbackUrl };
};

export type SupabaseAuth = ReturnType<typeof createSupabaseAuth>;
