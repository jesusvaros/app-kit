// Supabase side of push: keeps the device token row of the signed-in user.
//
// Two ways, the app picks:
// - `rpc` (recommended): two security-definer functions the app defines,
//   so a token that moves to another account (a shared phone) is reassigned
//   in one step. Called with p_token, p_platform, p_app_version, p_locale,
//   p_timezone (upsert) and p_token (remove).
// - `table`: a plain upsert on `token` with the user id from the session.
//   RLS must let users insert/update/delete their own rows.
/** Device locale and time zone, for the sender's quiet hours and language. */
export const deviceContext = () => {
    let timezone = null;
    try {
        timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    }
    catch {
        timezone = null;
    }
    const locale = typeof navigator !== 'undefined' && navigator.language ? navigator.language : null;
    return { locale, timezone };
};
export const createSupabasePushTokens = (options) => {
    const { supabase } = options;
    const upsertDeviceToken = async (device) => {
        if (!device.token)
            throw new Error('Falta el token del dispositivo.');
        if (options.rpc) {
            const { error } = await supabase.rpc(options.rpc.upsert, {
                p_token: device.token,
                p_platform: device.platform,
                p_app_version: device.appVersion ?? null,
                p_locale: device.locale ?? null,
                p_timezone: device.timezone ?? null,
            });
            if (error)
                throw error;
            return;
        }
        const { data } = await supabase.auth.getSession();
        const userId = data.session?.user.id;
        if (!userId)
            throw new Error('Sin sesión: no se puede guardar el token.');
        const { error } = await supabase.from(options.table).upsert({
            [options.userColumn ?? 'profile_id']: userId,
            token: device.token,
            platform: device.platform,
            app_version: device.appVersion ?? null,
            locale: device.locale ?? null,
            timezone: device.timezone ?? null,
            last_seen_at: new Date().toISOString(),
            disabled_at: null,
        }, { onConflict: 'token' });
        if (error)
            throw error;
    };
    /** Call before signing out (the session is still needed for RLS). */
    const removeDeviceToken = async (token) => {
        if (!token)
            return;
        if (options.rpc) {
            const { error } = await supabase.rpc(options.rpc.remove, { p_token: token });
            if (error)
                throw error;
            return;
        }
        const { error } = await supabase.from(options.table).delete().eq('token', token);
        if (error)
            throw error;
    };
    return { upsertDeviceToken, removeDeviceToken };
};
