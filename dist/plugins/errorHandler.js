import fp from "fastify-plugin";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";
export const errorHandlerPlugin = fp(async (app) => {
    app.setErrorHandler((err, req, reply) => {
        if (err instanceof AppError) {
            return reply.status(err.statusCode).send({
                error: { code: err.code, message: err.message, details: err.details ?? undefined },
            });
        }
        if (err instanceof ZodError) {
            return reply.status(400).send({
                error: {
                    code: "VALIDATION_ERROR",
                    message: "Validation failed",
                    details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
                },
            });
        }
        const anyErr = err;
        if (anyErr.statusCode === 429) {
            return reply.status(429).send({
                error: { code: "RATE_LIMITED", message: "Too many requests, please try again later" },
            });
        }
        if (anyErr.statusCode && anyErr.statusCode >= 400 && anyErr.statusCode < 500) {
            return reply.status(anyErr.statusCode).send({
                error: { code: anyErr.code ?? "BAD_REQUEST", message: anyErr.message ?? "Bad request" },
            });
        }
        req.log.error({ err }, "unhandled error");
        return reply.status(500).send({
            error: { code: "INTERNAL_ERROR", message: "Internal server error" },
        });
    });
    app.setNotFoundHandler((req, reply) => {
        reply.status(404).send({
            error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url} not found` },
        });
    });
});
