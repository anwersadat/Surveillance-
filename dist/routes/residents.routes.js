import { z } from "zod";
import { prisma } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { auditFromRequest } from "../lib/audit.js";
import { paginationQuery, offsetOf, pageResult } from "../lib/pagination.js";
const linkResidentSchema = z.object({
    userId: z.string(),
    apartmentId: z.string(),
    relation: z.enum(["OWNER", "TENANT", "FAMILY"]).default("OWNER"),
    isPrimary: z.boolean().default(false),
    moveInDate: z.string().optional(),
});
const guardSchema = z.object({
    userId: z.string(),
    employeeCode: z.string().trim().min(2).max(40),
    assignedGateId: z.string().optional(),
    phone: z.string().trim().max(30).optional(),
    shiftStart: z.string().optional(),
    shiftEnd: z.string().optional(),
});
export async function residentRoutes(app) {
    app.get("/api/residents", { ...app.requirePermission("residents:read"), schema: { tags: ["Residents"], summary: "List residents with apartment details" } }, async (req, reply) => {
        const q = paginationQuery
            .extend({ apartmentId: z.string().optional(), status: z.string().optional() })
            .parse(req.query);
        const where = {
            deletedAt: null,
            ...(q.apartmentId ? { apartmentId: q.apartmentId } : {}),
            ...(q.status ? { status: q.status } : {}),
            ...(q.q
                ? {
                    OR: [
                        { user: { name: { contains: q.q } } },
                        { user: { email: { contains: q.q } } },
                        { user: { phone: { contains: q.q } } },
                        { apartment: { flatNumber: { contains: q.q } } },
                    ],
                }
                : {}),
        };
        const [total, rows] = await Promise.all([
            prisma.resident.count({ where }),
            prisma.resident.findMany({
                where,
                include: {
                    user: { select: { id: true, name: true, email: true, phone: true, role: true, status: true, lastLoginAt: true } },
                    apartment: {
                        include: {
                            block: { include: { building: { select: { id: true, name: true } } } },
                            floor: { select: { number: true } },
                        },
                    },
                },
                orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
                skip: offsetOf(q.page, q.limit),
                take: q.limit,
            }),
        ]);
        return reply.send(pageResult(rows, total, q.page, q.limit));
    });
    app.get("/api/residents/:id", { ...app.requirePermission("residents:read"), schema: { tags: ["Residents"], summary: "Resident detail" } }, async (req, reply) => {
        const { id } = req.params;
        const resident = await prisma.resident.findFirst({
            where: { id, deletedAt: null },
            include: {
                user: { select: { id: true, name: true, email: true, phone: true, role: true, status: true, lastLoginAt: true, createdAt: true } },
                apartment: {
                    include: {
                        block: { include: { building: true } },
                        floor: { select: { number: true } },
                    },
                },
            },
        });
        if (!resident)
            throw notFound("Resident not found");
        return reply.send(resident);
    });
    app.get("/api/residents/:id/contact", { ...app.requirePermission("residents:contact"), schema: { tags: ["Residents"], summary: "Minimal contact info for gate staff (name, phone, flat)" } }, async (req, reply) => {
        const { id } = req.params;
        const resident = await prisma.resident.findFirst({
            where: { id, deletedAt: null },
            include: {
                user: { select: { name: true, phone: true, status: true } },
                apartment: { include: { block: { include: { building: { select: { name: true } } } } } },
            },
        });
        if (!resident)
            throw notFound("Resident not found");
        return reply.send({
            residentId: resident.id,
            name: resident.user.name,
            phone: resident.user.phone,
            flatNumber: resident.apartment.flatNumber,
            block: resident.apartment.block.name,
            building: resident.apartment.block.building.name,
            status: resident.status,
        });
    });
    app.post("/api/residents", { ...app.requirePermission("residents:write"), schema: { tags: ["Residents"], summary: "Link a user account to an apartment as a resident" } }, async (req, reply) => {
        const body = linkResidentSchema.parse(req.body);
        const [user, apartment] = await Promise.all([
            prisma.user.findFirst({ where: { id: body.userId, deletedAt: null } }),
            prisma.apartment.findFirst({ where: { id: body.apartmentId, deletedAt: null } }),
        ]);
        if (!user)
            throw notFound("User not found");
        if (!apartment)
            throw notFound("Apartment not found");
        const exists = await prisma.resident.findUnique({
            where: { userId_apartmentId: { userId: body.userId, apartmentId: body.apartmentId } },
        });
        if (exists)
            throw conflict("User is already linked to this apartment", "ALREADY_LINKED");
        const created = await prisma.resident.create({
            data: {
                userId: body.userId,
                apartmentId: body.apartmentId,
                relation: body.relation,
                isPrimary: body.isPrimary,
                moveInDate: body.moveInDate ? new Date(body.moveInDate) : null,
                createdBy: req.auth.user.id,
            },
        });
        await auditFromRequest(req)({ action: "RESIDENT_LINKED", entity: "Resident", entityId: created.id, metadata: { apartmentId: body.apartmentId } });
        return reply.status(201).send(created);
    });
    app.put("/api/residents/:id", { ...app.requirePermission("residents:write"), schema: { tags: ["Residents"], summary: "Update a resident link" } }, async (req, reply) => {
        const { id } = req.params;
        const body = linkResidentSchema.partial().omit({ userId: true, apartmentId: true }).parse(req.body);
        const existing = await prisma.resident.findFirst({ where: { id, deletedAt: null } });
        if (!existing)
            throw notFound("Resident not found");
        const updated = await prisma.resident.update({
            where: { id },
            data: {
                ...(body.relation ? { relation: body.relation } : {}),
                ...(body.isPrimary !== undefined ? { isPrimary: body.isPrimary } : {}),
                ...(body.moveInDate !== undefined ? { moveInDate: new Date(body.moveInDate) } : {}),
                updatedBy: req.auth.user.id,
            },
        });
        await auditFromRequest(req)({ action: "RESIDENT_UPDATED", entity: "Resident", entityId: id });
        return reply.send(updated);
    });
    app.delete("/api/residents/:id", { ...app.requirePermission("residents:write"), schema: { tags: ["Residents"], summary: "Deactivate a resident link" } }, async (req, reply) => {
        const { id } = req.params;
        const existing = await prisma.resident.findFirst({ where: { id, deletedAt: null } });
        if (!existing)
            throw notFound("Resident not found");
        await prisma.resident.update({ where: { id }, data: { status: "INACTIVE", deletedAt: new Date(), updatedBy: req.auth.user.id } });
        await auditFromRequest(req)({ action: "RESIDENT_DEACTIVATED", entity: "Resident", entityId: id });
        return reply.send({ ok: true });
    });
    app.get("/api/guards", { ...app.requirePermission("guards:read"), schema: { tags: ["Residents"], summary: "List security guards" } }, async (req, reply) => {
        const q = paginationQuery.parse(req.query);
        const where = { status: "ACTIVE", ...(q.q ? { OR: [{ employeeCode: { contains: q.q } }, { user: { name: { contains: q.q } } }] } : {}) };
        const [total, rows] = await Promise.all([
            prisma.securityGuardProfile.count({ where }),
            prisma.securityGuardProfile.findMany({
                where,
                include: {
                    user: { select: { id: true, name: true, email: true, phone: true, status: true, lastLoginAt: true } },
                    gate: { select: { id: true, name: true, code: true } },
                },
                orderBy: { createdAt: "desc" },
                skip: offsetOf(q.page, q.limit),
                take: q.limit,
            }),
        ]);
        return reply.send(pageResult(rows, total, q.page, q.limit));
    });
    app.post("/api/guards", { ...app.requirePermission("guards:write"), schema: { tags: ["Residents"], summary: "Create a security guard profile for a user" } }, async (req, reply) => {
        const body = guardSchema.parse(req.body);
        const user = await prisma.user.findFirst({ where: { id: body.userId, deletedAt: null } });
        if (!user)
            throw notFound("User not found");
        if (user.role !== "GUARD")
            throw badRequest("User must have the GUARD role", "INVALID_ROLE");
        const existing = await prisma.securityGuardProfile.findUnique({ where: { userId: body.userId } });
        if (existing)
            throw conflict("Guard profile already exists", "PROFILE_EXISTS");
        try {
            const created = await prisma.securityGuardProfile.create({
                data: {
                    userId: body.userId,
                    employeeCode: body.employeeCode,
                    assignedGateId: body.assignedGateId ?? null,
                    phone: body.phone ?? null,
                    shiftStart: body.shiftStart ?? null,
                    shiftEnd: body.shiftEnd ?? null,
                },
            });
            await auditFromRequest(req)({ action: "GUARD_CREATED", entity: "SecurityGuardProfile", entityId: created.id });
            return reply.status(201).send(created);
        }
        catch (err) {
            if (err.code === "P2002")
                throw conflict("Employee code already in use", "CODE_TAKEN");
            throw err;
        }
    });
    app.put("/api/guards/:id", { ...app.requirePermission("guards:write"), schema: { tags: ["Residents"], summary: "Update a guard profile" } }, async (req, reply) => {
        const { id } = req.params;
        const body = guardSchema.partial().parse(req.body);
        const existing = await prisma.securityGuardProfile.findUnique({ where: { id } });
        if (!existing)
            throw notFound("Guard profile not found");
        const updated = await prisma.securityGuardProfile.update({
            where: { id },
            data: {
                ...(body.assignedGateId !== undefined ? { assignedGateId: body.assignedGateId } : {}),
                ...(body.phone !== undefined ? { phone: body.phone } : {}),
                ...(body.shiftStart !== undefined ? { shiftStart: body.shiftStart } : {}),
                ...(body.shiftEnd !== undefined ? { shiftEnd: body.shiftEnd } : {}),
            },
        });
        await auditFromRequest(req)({ action: "GUARD_UPDATED", entity: "SecurityGuardProfile", entityId: id });
        return reply.send(updated);
    });
    app.delete("/api/guards/:id", { ...app.requirePermission("guards:write"), schema: { tags: ["Residents"], summary: "Deactivate a guard profile" } }, async (req, reply) => {
        const { id } = req.params;
        const existing = await prisma.securityGuardProfile.findUnique({ where: { id } });
        if (!existing)
            throw notFound("Guard profile not found");
        await prisma.securityGuardProfile.update({ where: { id }, data: { status: "INACTIVE" } });
        await auditFromRequest(req)({ action: "GUARD_DEACTIVATED", entity: "SecurityGuardProfile", entityId: id });
        return reply.send({ ok: true });
    });
}
export async function gateRoutes(app) {
    const gateSchema = z.object({
        name: z.string().trim().min(2).max(80),
        code: z.string().trim().min(1).max(40).toUpperCase(),
        type: z.enum(["MAIN", "SECONDARY", "SERVICE", "PARKING", "PEDESTRIAN"]).default("MAIN"),
        location: z.string().trim().max(200).optional(),
        buildingId: z.string().optional(),
        status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
    });
    app.get("/api/gates", { ...app.requirePermission("gates:read"), schema: { tags: ["Security"], summary: "List gates/entrances" } }, async (req, reply) => {
        const rows = await prisma.gate.findMany({
            where: { deletedAt: null },
            include: { _count: { select: { entries: true, cameras: true } } },
            orderBy: { name: "asc" },
        });
        return reply.send({ items: rows, total: rows.length });
    });
    app.post("/api/gates", { ...app.requirePermission("gates:write"), schema: { tags: ["Security"], summary: "Create a gate" } }, async (req, reply) => {
        const body = gateSchema.parse(req.body);
        try {
            const created = await prisma.gate.create({
                data: { ...body, location: body.location ?? null, buildingId: body.buildingId ?? null, createdBy: req.auth.user.id },
            });
            await auditFromRequest(req)({ action: "GATE_CREATED", entity: "Gate", entityId: created.id });
            return reply.status(201).send(created);
        }
        catch (err) {
            if (err.code === "P2002")
                throw conflict("Gate code already exists", "CODE_TAKEN");
            throw err;
        }
    });
    app.put("/api/gates/:id", { ...app.requirePermission("gates:write"), schema: { tags: ["Security"], summary: "Update a gate" } }, async (req, reply) => {
        const { id } = req.params;
        const body = gateSchema.partial().parse(req.body);
        const existing = await prisma.gate.findFirst({ where: { id, deletedAt: null } });
        if (!existing)
            throw notFound("Gate not found");
        const updated = await prisma.gate.update({
            where: { id },
            data: { ...body, location: body.location ?? undefined, updatedBy: req.auth.user.id },
        });
        await auditFromRequest(req)({ action: "GATE_UPDATED", entity: "Gate", entityId: id });
        return reply.send(updated);
    });
    app.delete("/api/gates/:id", { ...app.requirePermission("gates:write"), schema: { tags: ["Security"], summary: "Deactivate a gate" } }, async (req, reply) => {
        const { id } = req.params;
        const existing = await prisma.gate.findFirst({ where: { id, deletedAt: null } });
        if (!existing)
            throw notFound("Gate not found");
        await prisma.gate.update({ where: { id }, data: { deletedAt: new Date(), status: "INACTIVE" } });
        await auditFromRequest(req)({ action: "GATE_DELETED", entity: "Gate", entityId: id });
        return reply.send({ ok: true });
    });
}
export { forbidden };
