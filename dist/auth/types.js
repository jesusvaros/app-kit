export class SignInError extends Error {
    code;
    constructor(code, message) {
        super(message ?? code);
        this.name = 'SignInError';
        this.code = code;
    }
}
