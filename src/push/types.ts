export type PushPlatform = 'android' | 'ios' | 'web';

/**
 * Where the system permission stands. `unavailable`: the web, or a build
 * without @capacitor/push-notifications.
 */
export type PushPermission = 'granted' | 'denied' | 'prompt' | 'unavailable';

/** A notification as the app sees it, foreground or tapped. */
export type PushMessage = {
  id: string;
  title: string | null;
  body: string | null;
  /** The FCM/APNs data payload, e.g. { route: '/event/<id>' }. Always an object. */
  data: Record<string, unknown>;
};

/** A token the device got, and the one it replaced (FCM refresh), if any. */
export type PushTokenChange = { token: string; previous: string | null };

export type PushErrorCode = 'UNAVAILABLE' | 'NOT_GRANTED' | 'TIMEOUT' | 'FAILED';

export class PushError extends Error {
  readonly code: PushErrorCode;
  constructor(code: PushErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'PushError';
    this.code = code;
  }
}

/** Android notification channel (Android 8+). Importance 1 (min) … 5 (max); 3 default, 4 high (heads-up). */
export type PushChannel = {
  id: string;
  name: string;
  description?: string;
  importance?: 1 | 2 | 3 | 4 | 5;
  visibility?: -1 | 0 | 1;
  vibration?: boolean;
  lights?: boolean;
  lightColor?: string;
  sound?: string;
};
