/**
 * Custom exception classes for the shared HWPX converter.
 */

export class HwpxError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'HwpxError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export class TemplateError extends HwpxError {
    constructor(message: string) {
        super(message);
        this.name = 'TemplateError';
    }
}

export class ConversionError extends HwpxError {
    constructor(message: string) {
        super(message);
        this.name = 'ConversionError';
    }
}

export class SecurityError extends HwpxError {
    constructor(message: string) {
        super(message);
        this.name = 'SecurityError';
    }
}
