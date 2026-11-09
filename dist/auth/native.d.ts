import { type NativeIdentity, type Provider } from './types.js';
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
export declare const isCancellation: (error: unknown) => boolean;
export declare const createNativeSignIn: (config: NativeSignInConfig) => NativeSignIn;
