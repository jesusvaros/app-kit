const toHex = (bytes) => Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
/**
 * Replay protection for ID tokens: the provider gets `hashed` (SHA-256, hex)
 * and puts it in the token; the backend gets `raw`, hashes it and compares.
 */
export const createNonce = async () => {
    const raw = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const hashed = toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
    return { raw, hashed };
};
