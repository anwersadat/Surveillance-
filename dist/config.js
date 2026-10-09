import "dotenv/config";
const env = process.env.NODE_ENV ?? "development";
function b64key(name, fallback) {
    const raw = process.env[name] ?? fallback;
    return Buffer.from(raw, "base64");
}
export const config = {
    env,
    isProd: env === "production",
    isTest: env === "test",
    port: Number(process.env.PORT ?? 4000),
    host: process.env.HOST ?? "0.0.0.0",
    corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
    jwt: {
        accessSecret: process.env.JWT_ACCESS_SECRET ?? "dev-access-secret-change-me-in-production-0001",
        refreshSecret: process.env.JWT_REFRESH_SECRET ?? "dev-refresh-secret-change-me-in-production-0002",
        accessTtl: process.env.JWT_ACCESS_TTL ?? "15m",
        refreshTtl: process.env.JWT_REFRESH_TTL ?? "7d",
        accessTtlSeconds: 15 * 60,
        refreshTtlSeconds: 7 * 24 * 3600,
    },
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 300),
    authRateLimitMax: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
    uploadDir: process.env.UPLOAD_DIR ?? "uploads",
    encryptionKey: b64key("ENCRYPTION_KEY", "MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWY="),
    webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
};
