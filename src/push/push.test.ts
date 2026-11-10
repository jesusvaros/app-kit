import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ native: false, name: 'web', plugin: true }));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    getPlatform: () => platform.name,
    isPluginAvailable: () => platform.plugin,
  },
}));

type Listener = (payload: any) => void;
const fake = vi.hoisted(() => {
  const state = {
    permission: 'prompt' as string,
    afterRequest: 'granted' as string,
    listeners: new Map<string, Listener[]>(),
    onRegister: null as null | (() => void),
  };
  const emit = (event: string, payload: unknown) => state.listeners.get(event)?.forEach(listener => listener(payload));
  const PushNotifications = {
    checkPermissions: vi.fn(async () => ({ receive: state.permission })),
    requestPermissions: vi.fn(async () => {
      state.permission = state.afterRequest;
      return { receive: state.permission };
    }),
    register: vi.fn(async () => {
      state.onRegister?.();
    }),
    unregister: vi.fn(async () => undefined),
    createChannel: vi.fn(async () => undefined),
    addListener: vi.fn(async (event: string, listener: Listener) => {
      state.listeners.set(event, [...(state.listeners.get(event) ?? []), listener]);
      return { remove: vi.fn() };
    }),
  };
  return { state, emit, PushNotifications };
});
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: fake.PushNotifications }));

import { createAskPolicy, createPush, routeFromData, toPushMessage } from './index.js';
import { createSupabasePushTokens } from './supabase.js';

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
};

const setPlatform = (name: 'web' | 'android' | 'ios') => {
  platform.name = name;
  platform.native = name !== 'web';
};

beforeEach(() => {
  setPlatform('android');
  platform.plugin = true;
  fake.state.permission = 'prompt';
  fake.state.afterRequest = 'granted';
  fake.state.listeners.clear();
  fake.state.onRegister = null;
  vi.clearAllMocks();
});

describe('permission', () => {
  it('is unavailable on the web and never touches the plugin', async () => {
    setPlatform('web');
    const push = createPush({ storage: memoryStorage() });
    expect(await push.getPermissionState()).toBe('unavailable');
    expect(await push.requestPermissionWhenUseful()).toBe('unavailable');
    await expect(push.register()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(fake.PushNotifications.checkPermissions).not.toHaveBeenCalled();
  });

  it('opens the system prompt only while the answer is open', async () => {
    const push = createPush({ storage: memoryStorage() });
    fake.state.permission = 'prompt-with-rationale';
    expect(await push.getPermissionState()).toBe('prompt');
    expect(await push.requestPermissionWhenUseful()).toBe('granted');
    expect(fake.PushNotifications.requestPermissions).toHaveBeenCalledTimes(1);

    fake.state.permission = 'denied';
    expect(await push.requestPermissionWhenUseful()).toBe('denied');
    expect(fake.PushNotifications.requestPermissions).toHaveBeenCalledTimes(1);
  });
});

describe('register', () => {
  it('needs the permission first', async () => {
    const push = createPush({ storage: memoryStorage() });
    await expect(push.register()).rejects.toMatchObject({ code: 'NOT_GRANTED' });
    expect(fake.PushNotifications.register).not.toHaveBeenCalled();
  });

  it('stays off on platforms not listed (iOS without APNs)', async () => {
    setPlatform('ios');
    fake.state.permission = 'granted';
    const push = createPush({ registerOn: ['android'], storage: memoryStorage() });
    expect(push.canRegister()).toBe(false);
    await expect(push.register()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('creates the Android channels and resolves with the token', async () => {
    fake.state.permission = 'granted';
    fake.state.onRegister = () => fake.emit('registration', { value: 'tok-1' });
    const push = createPush({
      storage: memoryStorage(),
      channels: [{ id: 'conciertos', name: 'Conciertos', importance: 4 }],
    });
    const changes: unknown[] = [];
    push.onToken(change => changes.push(change));
    expect(await push.register()).toBe('tok-1');
    expect(fake.PushNotifications.createChannel).toHaveBeenCalledWith({ id: 'conciertos', name: 'Conciertos', importance: 4 });
    expect(push.currentToken()).toBe('tok-1');
    expect(changes).toEqual([{ token: 'tok-1', previous: null }]);
  });

  it('reports a refreshed token with the one it replaces, and not the same one twice', async () => {
    fake.state.permission = 'granted';
    const storage = memoryStorage();
    storage.setItem('app-kit.push.token', 'old');
    const push = createPush({ storage });
    const changes: unknown[] = [];
    push.onToken(change => changes.push(change));
    await push.listen();
    fake.emit('registration', { value: 'old' });
    fake.emit('registration', { value: 'new' });
    expect(changes).toEqual([{ token: 'new', previous: 'old' }]);
  });

  it('rejects with the registration error', async () => {
    fake.state.permission = 'granted';
    fake.state.onRegister = () => fake.emit('registrationError', { error: 'no google services' });
    const push = createPush({ storage: memoryStorage() });
    await expect(push.register()).rejects.toMatchObject({ code: 'FAILED', message: 'no google services' });
  });

  it('gives up when no token comes', async () => {
    fake.state.permission = 'granted';
    const push = createPush({ storage: memoryStorage(), registerTimeoutMs: 5 });
    await expect(push.register()).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('messages', () => {
  it('hands taps and foreground messages over with data as an object', async () => {
    const push = createPush({ storage: memoryStorage() });
    const tapped = vi.fn();
    const received = vi.fn();
    push.onTapped(tapped);
    push.onReceived(received);
    await push.listen();
    fake.emit('pushNotificationActionPerformed', {
      actionId: 'tap',
      notification: { id: '1', data: { route: '/event/abc' } },
    });
    fake.emit('pushNotificationReceived', { id: '2', title: 'Hoy', body: 'Toca', data: '{"route":"/pedidos/1"}' });
    expect(tapped).toHaveBeenCalledWith({ id: '1', title: null, body: null, data: { route: '/event/abc' } }, 'tap');
    expect(received).toHaveBeenCalledWith({ id: '2', title: 'Hoy', body: 'Toca', data: { route: '/pedidos/1' } });
  });

  it('survives junk payloads', () => {
    expect(toPushMessage(null)).toEqual({ id: '', title: null, body: null, data: {} });
    expect(toPushMessage({ id: 3, data: [1, 2] }).data).toEqual({});
  });

  it('stops calling a handler once unsubscribed', async () => {
    const push = createPush({ storage: memoryStorage() });
    const tapped = vi.fn();
    const stop = push.onTapped(tapped);
    await push.listen();
    stop();
    fake.emit('pushNotificationActionPerformed', { actionId: 'tap', notification: { id: '1', data: {} } });
    expect(tapped).not.toHaveBeenCalled();
  });
});

describe('routeFromData', () => {
  const allowed = ['/event/', '/tabs/'];
  it('keeps internal paths under an allowed prefix', () => {
    expect(routeFromData({ route: '/event/123' }, allowed)).toBe('/event/123');
    expect(routeFromData({ route: '/tabs/events?x=1' }, allowed)).toBe('/tabs/events?x=1');
    expect(routeFromData({ link: '/tabs/map' }, allowed, 'link')).toBe('/tabs/map');
  });
  it('ignores everything else', () => {
    for (const route of ['https://evil.test/event/1', '//evil.test/event/1', 'javascript:alert(1)', '/admin', '/event/../admin', '/\\evil', 42, null]) {
      expect(routeFromData({ route }, allowed)).toBeNull();
    }
    expect(routeFromData(undefined, allowed)).toBeNull();
  });
});

describe('ask policy', () => {
  const day = 24 * 60 * 60 * 1000;
  it('registers silently when granted and never asks when denied', () => {
    const policy = createAskPolicy({ storage: memoryStorage() });
    expect(policy.decide('granted')).toBe('register');
    expect(policy.decide('denied')).toBe('skip');
    expect(policy.decide('unavailable')).toBe('skip');
    expect(policy.decide('prompt')).toBe('explain');
  });
  it('waits the cooldown after «not now»', () => {
    let now = 1_000 * day;
    const policy = createAskPolicy({ storage: memoryStorage(), cooldownDays: 14, now: () => now });
    policy.declined();
    expect(policy.decide('prompt')).toBe('skip');
    now += 13 * day;
    expect(policy.decide('prompt')).toBe('skip');
    now += 1 * day + 1;
    expect(policy.decide('prompt')).toBe('explain');
    policy.declined();
    policy.reset();
    expect(policy.decide('prompt')).toBe('explain');
  });
});

describe('supabase tokens', () => {
  const fakeSupabase = () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const eq = vi.fn().mockResolvedValue({ error: null });
    return {
      rpc: vi.fn().mockResolvedValue({ error: null }),
      from: vi.fn(() => ({ upsert, delete: () => ({ eq }) })),
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } }) },
      upsert,
      eq,
    };
  };

  it('calls the app RPCs', async () => {
    const supabase = fakeSupabase();
    const tokens = createSupabasePushTokens({ supabase: supabase as never, rpc: { upsert: 'register_push_device', remove: 'unregister_push_device' } });
    await tokens.upsertDeviceToken({ platform: 'android', token: 't', appVersion: '1.2', locale: 'es-ES', timezone: 'Europe/Madrid' });
    expect(supabase.rpc).toHaveBeenCalledWith('register_push_device', {
      p_token: 't', p_platform: 'android', p_app_version: '1.2', p_locale: 'es-ES', p_timezone: 'Europe/Madrid',
    });
    await tokens.removeDeviceToken('t');
    expect(supabase.rpc).toHaveBeenLastCalledWith('unregister_push_device', { p_token: 't' });
  });

  it('upserts on the token in table mode with the session user', async () => {
    const supabase = fakeSupabase();
    const tokens = createSupabasePushTokens({ supabase: supabase as never, table: 'push_devices' });
    await tokens.upsertDeviceToken({ platform: 'android', token: 't' });
    expect(supabase.from).toHaveBeenCalledWith('push_devices');
    expect(supabase.upsert.mock.calls[0]![0]).toMatchObject({ profile_id: 'user-1', token: 't', platform: 'android', disabled_at: null });
    expect(supabase.upsert.mock.calls[0]![1]).toEqual({ onConflict: 'token' });
    await tokens.removeDeviceToken('t');
    expect(supabase.eq).toHaveBeenCalledWith('token', 't');
  });

  it('throws what Supabase returns', async () => {
    const supabase = fakeSupabase();
    supabase.rpc.mockResolvedValue({ error: new Error('rls') });
    const tokens = createSupabasePushTokens({ supabase: supabase as never, rpc: { upsert: 'a', remove: 'b' } });
    await expect(tokens.upsertDeviceToken({ platform: 'android', token: 't' })).rejects.toThrow('rls');
  });
});
