export type Provider = 'google' | 'apple';
export type SignInErrorCode = 'CANCELLED' | 'SHEET_TIMEOUT' | 'NO_TOKEN' | 'NOT_CONFIGURED' | 'FAILED';
export declare class SignInError extends Error {
    readonly code: SignInErrorCode;
    constructor(code: SignInErrorCode, message?: string);
}
/** What a native sheet returns: hand idToken and rawNonce to the backend. */
export type NativeIdentity = {
    provider: Provider;
    idToken: string;
    rawNonce: string;
    /** Only Apple, only on the first sign-in. Keep it for the profile. */
    name: string | null;
};
