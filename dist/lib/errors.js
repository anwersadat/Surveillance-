export class AppError extends Error {
    statusCode;
    code;
    details;
    constructor(statusCode, code, message, details) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
    }
}
export const badRequest = (msg = "Bad request", code = "BAD_REQUEST", details) => new AppError(400, code, msg, details);
export const unauthorized = (msg = "Authentication required", code = "UNAUTHORIZED") => new AppError(401, code, msg);
export const forbidden = (msg = "Forbidden", code = "FORBIDDEN") => new AppError(403, code, msg);
export const notFound = (msg = "Not found", code = "NOT_FOUND") => new AppError(404, code, msg);
export const conflict = (msg = "Conflict", code = "CONFLICT", details) => new AppError(409, code, msg, details);
export const tooMany = (msg = "Too many requests", code = "RATE_LIMITED") => new AppError(429, code, msg);
export const serverError = (msg = "Internal server error", code = "INTERNAL_ERROR") => new AppError(500, code, msg);
