import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ native: false, name: 'web' }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => platform.native, getPlatform: () => platform.name },
}));

import { createNonce, createNativeSignIn, SignInError, type NativeSignIn } from './index.js';
import { createSupabaseAuth } from './supabase.js';

const setPlatform = (name: 'web' | 'android' | 'ios') => {
  platform.name = name;
  platform.native = name !== 'web';
};

const fakeSupabase = () => ({
  auth: {
    signInWithIdToken: vi.fn().mockResolvedValue({ error: null }),
    signInWithOAuth: vi.fn().mockResolvedValue({ data: { url: 'https://provider/page' }, error: null }),
    updateUser: vi.fn().mockResolvedValue({ error: null }),
    exchangeCodeForSession: vi.fn().mockResolvedValue({ error: null }),
    setSession: vi.fn().mockResolvedValue({ error: null }),
  },
});

const fakeNative = (impl: NativeSignIn['signIn']): NativeSignIn => ({ isAvailable: () => true, signIn: vi.fn(impl) });

beforeEach(() => setPlatform('web'));

describe('nonce', () => {
  it('gives the provider the SHA-256 of the raw nonce', async () => {
    const nonce = await createNonce();
    expect(nonce.raw).toMatch(/^[0-9a-f]{64}$/);
    expect(nonce.hashed).toBe(createHash('sha256').update(nonce.raw).digest('hex'));
  });
});

describe('native availability', () => {
  const config = { google: { webClientId: 'web', iosClientId: 'ios' }, apple: { enabled: true } };
  it('is never native on the web', () => {
    expect(createNativeSignIn(config).isAvailable('google')).toBe(false);
  });
  it('needs the web client on Android and both clients on iOS', () => {
    setPlatform('android');
    expect(createNativeSignIn(config).isAvailable('google')).toBe(true);
    expect(createNativeSignIn({ google: {} }).isAvailable('google')).toBe(false);
    setPlatform('ios');
    expect(createNativeSignIn({ google: { webClientId: 'web' } }).isAvailable('google')).toBe(false);
    expect(createNativeSignIn(config).isAvailable('google')).toBe(true);
  });
  it('offers Apple only on iOS and only when switched on', () => {
    setPlatform('android');
    expect(createNativeSignIn(config).isAvailable('apple')).toBe(false);
    setPlatform('ios');
    expect(createNativeSignIn(config).isAvailable('apple')).toBe(true);
    expect(createNativeSignIn({}).isAvailable('apple')).toBe(false);
  });
});

describe('native Google request', () => {
  it('asks Google for no extra scopes (Android rejects them without MainActivity changes)', async () => {
    setPlatform('android');
    const login = vi.fn().mockResolvedValue({ provider: 'google', result: { idToken: 'jwt' } });
    vi.doMock('@capgo/capacitor-social-login', () => ({
      SocialLogin: { initialize: vi.fn().mockResolvedValue(undefined), logout: vi.fn().mockResolvedValue(undefined), login },
    }));
    vi.doMock('@capacitor/app', () => ({ App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) } }));
    const { createNativeSignIn: fresh } = await import('./native.js?scopes');
    const identity = await fresh({ google: { webClientId: 'web' } }).signIn('google');
    expect(identity.idToken).toBe('jwt');
    const options = login.mock.calls[0]![0].options;
    expect(options).not.toHaveProperty('scopes');
    expect(options.nonce).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('supabase sign-in', () => {
  it('hands the token and the raw nonce to Supabase, and keeps the Apple name', async () => {
    setPlatform('ios');
    const supabase = fakeSupabase();
    const native = fakeNative(async provider => ({ provider, idToken: 'jwt', rawNonce: 'raw', name: 'Ana Ruiz' }));
    const auth = createSupabaseAuth({ supabase: supabase as never, url: 'u', publishableKey: 'k', native });
    expect(await auth.signIn('apple')).toBe('signed-in');
    expect(supabase.auth.signInWithIdToken).toHaveBeenCalledWith({ provider: 'apple', token: 'jwt', nonce: 'raw' });
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({ data: { full_name: 'Ana Ruiz', display_name: 'Ana Ruiz' } });
  });

  it('does nothing more when the user closes the sheet', async () => {
    setPlatform('android');
    const supabase = fakeSupabase();
    const native = fakeNative(async () => {
      throw new SignInError('CANCELLED');
    });
    const auth = createSupabaseAuth({
      supabase: supabase as never, url: 'u', publishableKey: 'k', native,
      appCallbackUrl: 'com.app://auth/callback', openInAppBrowser: vi.fn(),
    });
    expect(await auth.signIn('google')).toBe('cancelled');
    expect(supabase.auth.signInWithOAuth).not.toHaveBeenCalled();
  });

  it('falls back to the in-app browser when the sheet breaks', async () => {
    setPlatform('android');
    const supabase = fakeSupabase();
    const openInAppBrowser = vi.fn().mockResolvedValue(undefined);
    const native = fakeNative(async () => {
      throw new SignInError('SHEET_TIMEOUT');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const auth = createSupabaseAuth({
      supabase: supabase as never, url: 'u', publishableKey: 'k', native,
      appCallbackUrl: 'com.app://auth/callback', openInAppBrowser,
    });
    expect(await auth.signIn('google')).toBe('redirecting');
    expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: 'com.app://auth/callback', skipBrowserRedirect: true },
    });
    expect(openInAppBrowser).toHaveBeenCalledWith('https://provider/page');
  });

  it('rethrows when the sheet breaks and there is no browser plan B', async () => {
    setPlatform('android');
    const native = fakeNative(async () => {
      throw new SignInError('SHEET_TIMEOUT');
    });
    const auth = createSupabaseAuth({ supabase: fakeSupabase() as never, url: 'u', publishableKey: 'k', native });
    await expect(auth.signIn('google')).rejects.toMatchObject({ code: 'SHEET_TIMEOUT' });
  });

  it('on the web saves state, then redirects back to the given path', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.test', pathname: '/now' } });
    const supabase = fakeSupabase();
    const beforeRedirect = vi.fn();
    const auth = createSupabaseAuth({ supabase: supabase as never, url: 'u', publishableKey: 'k' });
    expect(await auth.signIn('google', { returnPath: '/upload?qr=1', beforeRedirect })).toBe('redirecting');
    expect(beforeRedirect).toHaveBeenCalled();
    expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: 'https://app.test/upload?qr=1' },
    });
    vi.unstubAllGlobals();
  });
});

describe('providers shown', () => {
  const settings = (external: object) =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ external }) }));

  it('shows on the web what Supabase has on', async () => {
    settings({ google: true, apple: false });
    const auth = createSupabaseAuth({ supabase: fakeSupabase() as never, url: 'u', publishableKey: 'k' });
    expect(await auth.availableProviders()).toEqual({ google: true, apple: false });
    vi.unstubAllGlobals();
  });

  it('in the app hides a provider with neither a native sheet nor a browser plan B', async () => {
    setPlatform('android');
    settings({ google: true, apple: true });
    const native = createNativeSignIn({ google: { webClientId: 'web' } });
    const auth = createSupabaseAuth({ supabase: fakeSupabase() as never, url: 'u', publishableKey: 'k', native });
    expect(await auth.availableProviders()).toEqual({ google: true, apple: false });
    vi.unstubAllGlobals();
  });
});

describe('deep link back from the browser', () => {
  const auth = (supabase = fakeSupabase()) => ({
    supabase,
    kit: createSupabaseAuth({ supabase: supabase as never, url: 'u', publishableKey: 'k', appCallbackUrl: 'com.app://auth/callback' }),
  });
  it('stores the session from a PKCE code', async () => {
    const { supabase, kit } = auth();
    expect(await kit.handleCallbackUrl('com.app://auth/callback?code=abc')).toEqual({ kind: 'signed-in' });
    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledWith('abc');
  });
  it('recognises a password recovery link', async () => {
    const { kit } = auth();
    expect(await kit.handleCallbackUrl('com.app://auth/callback#access_token=a&refresh_token=r&type=recovery')).toEqual({ kind: 'recovery' });
  });
  it('reports provider errors and ignores other links', async () => {
    const { kit } = auth();
    expect(await kit.handleCallbackUrl('com.app://auth/callback?error_description=Access+denied')).toEqual({ kind: 'error', message: 'Access denied' });
    expect(await kit.handleCallbackUrl('com.app://upload?qr=1')).toEqual({ kind: 'ignored' });
  });
});
