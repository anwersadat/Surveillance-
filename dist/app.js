import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";
import { authPlugin } from "./plugins/auth.js";
import { errorHandlerPlugin } from "./plugins/errorHandler.js";
import { swaggerPlugin } from "./plugins/swagger.js";
import { websocketPlugin } from "./plugins/websocket.js";
import { authRoutes } from "./routes/auth.routes.js";
import { userRoutes } from "./routes/users.routes.js";
import { buildingRoutes } from "./routes/buildings.routes.js";
import { residentRoutes, gateRoutes } from "./routes/residents.routes.js";
import { invitationRoutes } from "./routes/invitations.routes.js";
import { visitorFlowRoutes } from "./routes/visitors.routes.js";
import { securityRoutes } from "./routes/security.routes.js";
import { notificationRoutes, settingsRoutes } from "./routes/settings.routes.js";
import { deviceRoutes } from "./routes/devices.routes.js";
import { auditRoutes, reportRoutes } from "./routes/audit.routes.js";
import { dashboardRoutes, publicRoutes, uploadRoutes, miscRoutes } from "./routes/dashboard.routes.js";
export async function buildApp() {
    const app = Fastify({
        logger: config.isTest
            ? false
            : {
                level: process.env.LOG_LEVEL ?? (config.isProd ? "info" : "warn"),
                transport: config.isProd ? undefined : undefined,
            },
        trustProxy: true,
        bodyLimit: 1024 * 1024,
        ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    await app.register(helmet, {
        contentSecurityPolicy: false,
        crossOriginResourcePolicy: { policy: "cross-origin" },
    });
    await app.register(cors, {
        origin: config.corsOrigin.split(",").map((o) => o.trim()),
        credentials: true,
    });
    await app.register(rateLimit, {
        max: config.rateLimitMax,
        timeWindow: "1 minute",
    });
    await app.register(jwt, {
        secret: config.jwt.accessSecret,
    });
    await app.register(multipart, {
        limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    });
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await app.register(swaggerPlugin);
    await app.register(websocketPlugin);
    const uploadRoot = resolve(process.cwd(), config.uploadDir);
    mkdirSync(uploadRoot, { recursive: true });
    await app.register(fastifyStatic, {
        root: uploadRoot,
        prefix: "/uploads/",
        index: false,
        decorateReply: true,
    });
    await app.register(authRoutes);
    await app.register(userRoutes);
    await app.register(buildingRoutes);
    await app.register(residentRoutes);
    await app.register(gateRoutes);
    await app.register(invitationRoutes);
    await app.register(visitorFlowRoutes);
    await app.register(securityRoutes);
    await app.register(notificationRoutes);
    await app.register(settingsRoutes);
    await app.register(deviceRoutes);
    await app.register(auditRoutes);
    await app.register(reportRoutes);
    await app.register(dashboardRoutes);
    await app.register(publicRoutes);
    await app.register(uploadRoutes);
    await app.register(miscRoutes);
    await app.ready();
    return app;
}
