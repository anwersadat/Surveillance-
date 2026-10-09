import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startBackgroundJobs } from "./jobs/sweeps.js";
const INSECURE_SECRETS = [
    "dev-access-secret-change-me-in-production-0001",
    "dev-refresh-secret-change-me-in-production-0002",
    "change-me-access-secret",
    "change-me-refresh-secret",
];
const DEFAULT_ENCRYPTION_KEY = "MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWY=";
if (config.isProd) {
    const insecure = INSECURE_SECRETS.includes(config.jwt.accessSecret) ||
        INSECURE_SECRETS.includes(config.jwt.refreshSecret) ||
        config.encryptionKey.toString("base64") === DEFAULT_ENCRYPTION_KEY;
    if (insecure) {
        console.error("[FATAL] Refusing to start with default secrets. " +
            "Set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET (openssl rand -hex 32) and " +
            `ENCRYPTION_KEY (openssl rand -base64 32).`);
        process.exit(1);
    }
}
const app = await buildApp();
startBackgroundJobs();
try {
    await app.listen({ port: config.port, host: config.host });
    app.log?.info(`API listening on :${config.port}`);
    console.log(`SecureResident API listening on http://localhost:${config.port} (docs at /docs)`);
}
catch (err) {
    console.error("Failed to start server", err);
    process.exit(1);
}
const shutdown = async (signal) => {
    console.log(`Received ${signal}, shutting down...`);
    await app.close();
    process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
