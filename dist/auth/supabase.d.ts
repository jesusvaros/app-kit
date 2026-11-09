import type { SupabaseClient } from '@supabase/supabase-js';
import type { NativeSignIn } from './native.js';
import { type Provider } from './types.js';
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
'signed-in'
/** Left for the provider page; the session comes back by redirect or deep link. */
 | 'redirecting' | 'cancelled';
export type SignInOptions = {
    /** Web only: path to come back to after the provider page. */
    returnPath?: string;
    /** Web only: runs before the page is left (save what the user was doing). */
    beforeRedirect?: () => Promise<void> | void;
};
export type CallbackResult = {
    kind: 'signed-in';
} | {
    kind: 'recovery';
} | {
    kind: 'error';
    message: string;
} | {
    kind: 'ignored';
};
export declare const createSupabaseAuth: (options: SupabaseAuthOptions) => {
    availableProviders: () => Promise<Record<Provider, boolean>>;
    signIn: (provider: Provider, signInOptions?: SignInOptions) => Promise<SignInOutcome>;
    handleCallbackUrl: (rawUrl: string) => Promise<CallbackResult>;
};
export type SupabaseAuth = ReturnType<typeof createSupabaseAuth>;
