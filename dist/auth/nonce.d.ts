/**
 * Replay protection for ID tokens: the provider gets `hashed` (SHA-256, hex)
 * and puts it in the token; the backend gets `raw`, hashes it and compares.
 */
export declare const createNonce: () => Promise<{
    raw: string;
    hashed: string;
}>;
