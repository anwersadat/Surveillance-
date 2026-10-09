import { z } from "zod";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { AppError, badRequest, forbidden, unauthorized } from "../lib/errors.js";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "../lib/passwords.js";
import { permissionsForRole } from "../lib/rbac.js";
import { randomToken, sha256 } from "../lib/codes.js";
import { auditFromRequest, writeAudit } from "../lib/audit.js";
const loginSchema = z.object({
    email: z.string().trim().email().toLowerCase(),
    password: z.string().min(1),
});
const refreshSchema = z.object({ refreshToken: z.string().min(20) });
const changePasswordSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(10),
});
const LOCK_THRESHOLD = 5;
const LOCK_MINUTES = 15;
async function loadAuthUser(userId) {
    const user = await prisma.user.findFirst({
        where: { id: userId, status: "ACTIVE", deletedAt: null },
        include: { residents: { where: { status: "ACTIVE", deletedAt: null } } },
    });
    if (!user)
        return null;
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        apartmentIds: user.residents.map((r) => r.apartmentId),
        residentIds: user.residents.map((r) => r.id),
    };
}
export async function buildProfile(userId) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
            residents: {
                where: { status: "ACTIVE", deletedAt: null },
                include: {
                    apartment: {
                        include: {
                            block: { include: { building: { select: { id: true, name: true, code: true } } } },
                            floor: { select: { number: true } },
                        },
                    },
                },
            },
            guardProfile: { include: { gate: { select: { id: true, name: true } } } },
        },
    });
    if (!user)
        return null;
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        role: user.role,
        status: user.status,
        mustChangePassword: user.mustChangePassword,
        permissions: permissionsForRole(user.role),
        guard: user.guardProfile
            ? { employeeCode: user.guardProfile.employeeCode, gate: user.guardProfile.gate }
            : null,
        apartments: user.residents.map((r) => ({
            residentId: r.id,
            relation: r.relation,
            isPrimary: r.isPrimary,
            apartmentId: r.apartmentId,
            flatNumber: r.apartment.flatNumber,
            floor: r.apartment.floor.number,
            block: r.apartment.block.name,
            building: r.apartment.block.building.name,
            buildingId: r.apartment.block.building.id,
        })),
    };
}
async function issueTokens(app, userId, role) {
    const accessToken = app.jwt.sign({ sub: userId, role }, { expiresIn: config.jwt.accessTtl });
    const refreshToken = randomToken(48);
    await prisma.refreshToken.create({
        data: {
            tokenHash: sha256(refreshToken),
            userId,
            expiresAt: new Date(Date.now() + config.jwt.refreshTtlSeconds * 1000),
        },
    });
    return { accessToken, refreshToken, expiresIn: config.jwt.accessTtlSeconds };
}
export async function authRoutes(app) {
    app.post("/api/auth/login", {
        config: { rateLimit: { max: config.authRateLimitMax, timeWindow: "1 minute" } },
        schema: {
            tags: ["Auth"],
            summary: "Log in with email and password",
            description: "Returns a JWT access token, a rotating refresh token and the user profile with permissions. Accounts lock for 15 minutes after 5 failed attempts.",
        },
    }, async (req, reply) => {
        const { email, password } = loginSchema.parse(req.body);
        const user = await prisma.user.findUnique({ where: { email } });
        const genericError = unauthorized("Invalid email or password", "INVALID_CREDENTIALS");
        if (!user || user.deletedAt) {
            await writeAudit(null, null, { action: "LOGIN_FAILED", result: "FAILURE", metadata: { email } }, req);
            throw genericError;
        }
        if (user.status !== "ACTIVE") {
            await writeAudit(user.id, user.role, { action: "LOGIN_DENIED", result: "FAILURE", metadata: { reason: "disabled" } }, req);
            throw forbidden("Account is disabled", "ACCOUNT_DISABLED");
        }
        if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
            await writeAudit(user.id, user.role, { action: "LOGIN_DENIED", result: "FAILURE", metadata: { reason: "locked" } }, req);
            throw new AppError(429, "ACCOUNT_LOCKED", `Account locked. Try again after ${user.lockedUntil.toLocaleTimeString()}`);
        }
        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) {
            const fails = user.failedLoginCount + 1;
            const lockedUntil = fails >= LOCK_THRESHOLD ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
            await prisma.user.update({
                where: { id: user.id },
                data: { failedLoginCount: fails, lockedUntil },
            });
            await writeAudit(user.id, user.role, { action: "LOGIN_FAILED", result: "FAILURE", metadata: { attempts: fails } }, req);
            throw genericError;
        }
        await prisma.user.update({
            where: { id: user.id },
            data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
        });
        const tokens = await issueTokens(app, user.id, user.role);
        const profile = await buildProfile(user.id);
        await writeAudit(user.id, user.role, { action: "LOGIN", entity: "User", entityId: user.id }, req);
        return reply.send({ ...tokens, user: profile });
    });
    app.post("/api/auth/refresh", {
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: { tags: ["Auth"], summary: "Exchange a refresh token for a new access token (rotating)" },
    }, async (req, reply) => {
        const { refreshToken } = refreshSchema.parse(req.body);
        const hash = sha256(refreshToken);
        const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hash }, include: { user: true } });
        if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) {
            throw unauthorized("Refresh token is invalid or expired", "INVALID_REFRESH_TOKEN");
        }
        if (row.user.status !== "ACTIVE" || row.user.deletedAt) {
            throw forbidden("Account is disabled", "ACCOUNT_DISABLED");
        }
        await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
        const tokens = await issueTokens(app, row.user.id, row.user.role);
        const profile = await buildProfile(row.user.id);
        return reply.send({ ...tokens, user: profile });
    });
    app.post("/api/auth/logout", { preHandler: [app.authenticate], schema: { tags: ["Auth"], summary: "Revoke all refresh tokens for the current user" } }, async (req, reply) => {
        const auth = req.auth;
        await prisma.refreshToken.updateMany({
            where: { userId: auth.user.id, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        await auditFromRequest(req)({ action: "LOGOUT", entity: "User", entityId: auth.user.id });
        return reply.send({ ok: true });
    });
    app.get("/api/auth/me", { preHandler: [app.authenticate], schema: { tags: ["Auth"], summary: "Current user profile, permissions and apartments" } }, async (req, reply) => {
        const profile = await buildProfile(req.auth.user.id);
        if (!profile)
            throw unauthorized("Account not found");
        return reply.send(profile);
    });
    app.post("/api/auth/change-password", {
        preHandler: [app.authenticate],
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        schema: { tags: ["Auth"], summary: "Change own password" },
    }, async (req, reply) => {
        const body = changePasswordSchema.parse(req.body);
        const auth = req.auth;
        const user = await prisma.user.findUnique({ where: { id: auth.user.id } });
        if (!user)
            throw unauthorized();
        if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
            throw unauthorized("Current password is incorrect", "INVALID_CREDENTIALS");
        }
        const policy = checkPasswordPolicy(body.newPassword);
        if (!policy.ok)
            throw badRequest(policy.errors.join("; "), "WEAK_PASSWORD", policy.errors);
        await prisma.user.update({
            where: { id: user.id },
            data: { passwordHash: await hashPassword(body.newPassword), mustChangePassword: false },
        });
        await prisma.refreshToken.updateMany({
            where: { userId: user.id, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        await auditFromRequest(req)({ action: "PASSWORD_CHANGED", entity: "User", entityId: user.id });
        return reply.send({ ok: true, sessionsRevoked: true });
    });
    app.get("/api/auth/permissions", { preHandler: [app.authenticate], schema: { tags: ["Auth"], summary: "Permission list for the current user" } }, async (req, reply) => reply.send({ permissions: req.auth.permissions, role: req.auth.user.role }));
}
