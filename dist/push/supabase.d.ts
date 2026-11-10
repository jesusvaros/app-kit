import type { SupabaseClient } from '@supabase/supabase-js';
import type { PushPlatform } from './types.js';
export type DeviceToken = {
    platform: PushPlatform;
    token: string;
    appVersion?: string | null;
    locale?: string | null;
    timezone?: string | null;
};
export type SupabasePushOptions = {
    supabase: SupabaseClient<any, any, any>;
} & ({
    rpc: {
        upsert: string;
        remove: string;
    };
    table?: never;
} | {
    table: string;
    rpc?: never;
    /** Column with the owner. Default 'profile_id'. */
    userColumn?: string;
});
/** Device locale and time zone, for the sender's quiet hours and language. */
export declare const deviceContext: () => {
    locale: string | null;
    timezone: string | null;
};
export declare const createSupabasePushTokens: (options: SupabasePushOptions) => {
    upsertDeviceToken: (device: DeviceToken) => Promise<void>;
    removeDeviceToken: (token: string) => Promise<void>;
};
export type SupabasePushTokens = ReturnType<typeof createSupabasePushTokens>;
