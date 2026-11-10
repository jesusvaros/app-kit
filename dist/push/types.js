export class PushError extends Error {
    code;
    constructor(code, message) {
        super(message ?? code);
        this.name = 'PushError';
        this.code = code;
    }
}
