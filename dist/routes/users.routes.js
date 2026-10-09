import { z } from "zod";
import { prisma } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { checkPasswordPolicy, hashPassword } from "../lib/passwords.js";
import { ROLES, permissionsForRole } from "../lib/rbac.js";
import { auditFromRequest } from "../lib/audit.js";
import { paginationQuery, offsetOf, pageResult } from "../lib/pagination.js";
const ADMIN_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SECURITY, ROLES.GUARD, ROLES.RESIDENT];
const createUserSchema = z.object({
    email: z.string().trim().email().toLowerCase(),
    name: z.string().trim().min(2).max(120),
    phone: z.string().trim().max(30).optional(),
    role: z.enum([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SECURITY, ROLES.GUARD, ROLES.RESIDENT]),
    password: z.string().min(10),
    apartmentId: z.string().optional(),
    employeeCode: z.string().trim().max(40).optional(),
    assignedGateId: z.string().optional(),
});
const updateUserSchema = z.object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().max(30).optional(),
    role: z.enum([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SECURITY, ROLES.GUARD, ROLES.RESIDENT]).optional(),
    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
    password: z.string().min(10).optional(),
    assignedGateId: z.string().optional(),
});
export async function userRoutes(app) {
    app.get("/api/users", { ...app.requirePermission("users:read"), schema: { tags: ["Admin"], summary: "List users (paginated, filterable)" } }, async (req, reply) => {
        const q = paginationQuery.extend({ role: z.string().optional(), status: z.string().optional() }).parse(req.query);
        const where = {
            deletedAt: null,
            ...(q.role ? { role: q.role } : {}),
            ...(q.status ? { status: q.status } : {}),
            ...(q.q ? { OR: [{ name: { contains: q.q } }, { email: { contains: q.q } }, { phone: { contains: q.q } }] } : {}),
        };
        const [total, rows] = await Promise.all([
            prisma.user.count({ where }),
            prisma.user.findMany({
                where,
                select: {
                    id: true, email: true, name: true, phone: true, role: true, status: true,
                    mustChangePassword: true, lastLoginAt: true, createdAt: true,
                    residents: { select: { apartment: { select: { flatNumber: true } } } },
                    guardProfile: { select: { employeeCode: true, gate: { select: { name: true } } } },
                },
                orderBy: { createdAt: "desc" },
                skip: offsetOf(q.page, q.limit),
                take: q.limit,
            }),
        ]);
        return reply.send(pageResult(rows.map((u) => ({
            ...u,
            apartments: u.residents.map((r) => r.apartment.flatNumber),
            guard: u.guardProfile,
            permissions: permissionsForRole(u.role),
        })), total, q.page, q.limit));
    });
    app.post("/api/users", { ...app.requirePermission("users:write"), schema: { tags: ["Admin"], summary: "Create a user account" } }, async (req, reply) => {
        const body = createUserSchema.parse(req.body);
        if (body.role === ROLES.SUPER_ADMIN && req.auth.user.role !== ROLES.SUPER_ADMIN) {
            throw badRequest("Only a super administrator can create super administrator accounts", "PRIVILEGE_ESCALATION");
        }
        const policy = checkPasswordPolicy(body.password);
        if (!policy.ok)
            throw badRequest(policy.errors.join("; "), "WEAK_PASSWORD", policy.errors);
        const existing = await prisma.user.findUnique({ where: { email: body.email } });
        if (existing)
            throw conflict("A user with this email already exists", "EMAIL_TAKEN");
        const user = await prisma.user.create({
            data: {
                email: body.email,
                name: body.name,
                phone: body.phone ?? null,
                role: body.role,
                passwordHash: await hashPassword(body.password),
                mustChangePassword: true,
                createdBy: req.auth.user.id,
            },
        });
        if (body.role === ROLES.RESIDENT) {
            if (!body.apartmentId)
                throw badRequest("apartmentId is required for residents", "APARTMENT_REQUIRED");
            const apartment = await prisma.apartment.findFirst({ where: { id: body.apartmentId, deletedAt: null } });
            if (!apartment)
                throw notFound("Apartment not found");
            await prisma.resident.create({
                data: {
                    userId: user.id,
                    apartmentId: body.apartmentId,
                    relation: "OWNER",
                    isPrimary: true,
                    createdBy: req.auth.user.id,
                },
            });
        }
        if (body.role === ROLES.GUARD) {
            const code = body.employeeCode ?? `GRD-${Date.now().toString(36).toUpperCase()}`;
            const exists = await prisma.securityGuardProfile.findUnique({ where: { employeeCode: code } });
            if (exists)
                throw conflict("Employee code already in use", "EMPLOYEE_CODE_TAKEN");
            await prisma.securityGuardProfile.create({
                data: { userId: user.id, employeeCode: code, assignedGateId: body.assignedGateId ?? null },
            });
        }
        await auditFromRequest(req)({ action: "USER_CREATED", entity: "User", entityId: user.id, metadata: { role: user.role, email: user.email } });
        return reply.status(201).send({ id: user.id, email: user.email, role: user.role });
    });
    app.put("/api/users/:id", { ...app.requirePermission("users:write"), schema: { tags: ["Admin"], summary: "Update a user account" } }, async (req, reply) => {
        const { id } = req.params;
        const body = updateUserSchema.parse(req.body);
        const user = await prisma.user.findFirst({ where: { id, deletedAt: null } });
        if (!user)
            throw notFound("User not found");
        if (user.role === ROLES.SUPER_ADMIN && req.auth.user.role !== ROLES.SUPER_ADMIN) {
            throw badRequest("Only a super administrator can modify super administrator accounts", "PRIVILEGE_ESCALATION");
        }
        if (body.role && user.role === ROLES.SUPER_ADMIN && body.role !== ROLES.SUPER_ADMIN && req.auth.user.role !== ROLES.SUPER_ADMIN) {
            throw badRequest("Only a super administrator can change this role", "PRIVILEGE_ESCALATION");
        }
        const data = {};
        if (body.name !== undefined)
            data.name = body.name;
        if (body.phone !== undefined)
            data.phone = body.phone;
        if (body.role !== undefined)
            data.role = body.role;
        if (body.status !== undefined) {
            data.status = body.status;
            if (body.status === "DISABLED")
                data.lockedUntil = null;
        }
        if (body.password) {
            const policy = checkPasswordPolicy(body.password);
            if (!policy.ok)
                throw badRequest(policy.errors.join("; "), "WEAK_PASSWORD", policy.errors);
            data.passwordHash = await hashPassword(body.password);
            data.mustChangePassword = true;
        }
        data.updatedBy = req.auth.user.id;
        const updated = await prisma.user.update({ where: { id }, data });
        if (body.assignedGateId !== undefined && updated.role === ROLES.GUARD) {
            await prisma.securityGuardProfile.updateMany({
                where: { userId: id },
                data: { assignedGateId: body.assignedGateId },
            });
        }
        await auditFromRequest(req)({ action: "USER_UPDATED", entity: "User", entityId: id, metadata: { fields: Object.keys(body) } });
        return reply.send({ id: updated.id, email: updated.email, role: updated.role, status: updated.status });
    });
    app.delete("/api/users/:id", { ...app.requirePermission("users:write"), schema: { tags: ["Admin"], summary: "Deactivate (soft-delete) a user" } }, async (req, reply) => {
        const { id } = req.params;
        const user = await prisma.user.findFirst({ where: { id, deletedAt: null } });
        if (!user)
            throw notFound("User not found");
        if (user.id === req.auth.user.id)
            throw badRequest("You cannot deactivate your own account", "SELF_DEACTIVATE");
        if (user.role === ROLES.SUPER_ADMIN && req.auth.user.role !== ROLES.SUPER_ADMIN) {
            throw badRequest("Cannot deactivate a super administrator", "PRIVILEGE_ESCALATION");
        }
        await prisma.user.update({
            where: { id },
            data: { status: "DISABLED", deletedAt: new Date(), updatedBy: req.auth.user.id },
        });
        await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
        await auditFromRequest(req)({ action: "USER_DEACTIVATED", entity: "User", entityId: id });
        return reply.send({ ok: true });
    });
}
export { ADMIN_ROLES };
