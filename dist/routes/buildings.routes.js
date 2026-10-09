import { z } from "zod";
import { prisma } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { auditFromRequest } from "../lib/audit.js";
import { paginationQuery, offsetOf, pageResult } from "../lib/pagination.js";
const buildingSchema = z.object({
    name: z.string().trim().min(2).max(120),
    code: z.string().trim().min(1).max(40).toUpperCase(),
    address: z.string().trim().max(300).optional(),
});
const blockSchema = z.object({
    name: z.string().trim().min(1).max(80),
    code: z.string().trim().min(1).max(40).toUpperCase(),
    buildingId: z.string(),
});
const floorSchema = z.object({
    number: z.coerce.number().int().min(-5).max(200),
    label: z.string().trim().max(60).optional(),
    blockId: z.string(),
});
const apartmentSchema = z.object({
    flatNumber: z.string().trim().min(1).max(40),
    blockId: z.string(),
    floorId: z.string(),
    bedroomCount: z.coerce.number().int().min(0).max(20).optional(),
    area: z.string().trim().max(60).optional(),
});
export async function buildingRoutes(app) {
    app.get("/api/buildings", { ...app.requirePermission("buildings:read"), schema: { tags: ["Residents"], summary: "List buildings with blocks, floors and apartments" } }, async (req, reply) => {
        const q = paginationQuery.parse(req.query);
        const where = {
            deletedAt: null,
            ...(q.q ? { OR: [{ name: { contains: q.q } }, { code: { contains: q.q.toUpperCase() } }] } : {}),
        };
        const [total, rows] = await Promise.all([
            prisma.building.count({ where }),
            prisma.building.findMany({
                where,
                include: {
                    blocks: {
                        include: {
                            floors: { orderBy: { number: "asc" }, include: { apartments: { orderBy: { flatNumber: "asc" } } } },
                            apartments: { orderBy: { flatNumber: "asc" } },
                        },
                        orderBy: { name: "asc" },
                    },
                },
                orderBy: { name: "asc" },
                skip: offsetOf(q.page, q.limit),
                take: q.limit,
            }),
        ]);
        return reply.send(pageResult(rows, total, q.page, q.limit));
    });
    app.post("/api/buildings", { ...app.requirePermission("buildings:write"), schema: { tags: ["Residents"], summary: "Create a building" } }, async (req, reply) => {
        const body = buildingSchema.parse(req.body);
        const exists = await prisma.building.findUnique({ where: { code: body.code } });
        if (exists)
            throw conflict("Building code already exists", "CODE_TAKEN");
        const created = await prisma.building.create({
            data: { ...body, address: body.address ?? null, createdBy: req.auth.user.id },
        });
        await auditFromRequest(req)({ action: "BUILDING_CREATED", entity: "Building", entityId: created.id });
        return reply.status(201).send(created);
    });
    app.put("/api/buildings/:id", { ...app.requirePermission("buildings:write"), schema: { tags: ["Residents"], summary: "Update a building" } }, async (req, reply) => {
        const { id } = req.params;
        const body = buildingSchema.partial().parse(req.body);
        const existing = await prisma.building.findFirst({ where: { id, deletedAt: null } });
        if (!existing)
            throw notFound("Building not found");
        const updated = await prisma.building.update({
            where: { id },
            data: { ...body, updatedBy: req.auth.user.id },
        });
        await auditFromRequest(req)({ action: "BUILDING_UPDATED", entity: "Building", entityId: id });
        return reply.send(updated);
    });
    app.delete("/api/buildings/:id", { ...app.requirePermission("buildings:write"), schema: { tags: ["Residents"], summary: "Deactivate a building (soft delete)" } }, async (req, reply) => {
        const { id } = req.params;
        const existing = await prisma.building.findFirst({ where: { id, deletedAt: null } });
        if (!existing)
            throw notFound("Building not found");
        await prisma.building.update({ where: { id }, data: { deletedAt: new Date(), status: "INACTIVE" } });
        await auditFromRequest(req)({ action: "BUILDING_DELETED", entity: "Building", entityId: id });
        return reply.send({ ok: true });
    });
    app.post("/api/blocks", { ...app.requirePermission("buildings:write"), schema: { tags: ["Residents"], summary: "Create a block/tower" } }, async (req, reply) => {
        const body = blockSchema.parse(req.body);
        const building = await prisma.building.findFirst({ where: { id: body.buildingId, deletedAt: null } });
        if (!building)
            throw notFound("Building not found");
        try {
            const created = await prisma.block.create({ data: body });
            await auditFromRequest(req)({ action: "BLOCK_CREATED", entity: "Block", entityId: created.id });
            return reply.status(201).send(created);
        }
        catch (err) {
            if (err.code === "P2002")
                throw conflict("Block code already exists in building", "CODE_TAKEN");
            throw err;
        }
    });
    app.put("/api/blocks/:id", { ...app.requirePermission("buildings:write"), schema: { tags: ["Residents"], summary: "Update a block" } }, async (req, reply) => {
        const { id } = req.params;
        const body = blockSchema.partial().parse(req.body);
        const existing = await prisma.block.findFirst({ where: { id, deletedAt: null } });
        if (!existing)
            throw notFound("Block not found");
        const updated = await prisma.block.update({ where: { id }, data: body });
        await auditFromRequest(req)({ action: "BLOCK_UPDATED", entity: "Block", entityId: id });
        return reply.send(updated);
    });
    app.delete("/api/blocks/:id", { ...app.requirePermission("buildings:write"), schema: { tags: ["Residents"], summary: "Delete a block (soft delete)" } }, async (req, reply) => {
        const { id } = req.params;
        const existing = await prisma.block.findFirst({ where: { id, deletedAt: null } });
        if (!existing)
            throw notFound("Block not found");
        await prisma.block.update({ where: { id }, data: { deletedAt: new Date() } });
        await auditFromRequest(req)({ action: "BLOCK_DELETED", entity: "Block", entityId: id });
        return reply.send({ ok: true });
    });
    app.post("/api/floors", { ...app.requirePermission("buildings:write"), schema: { tags: ["Residents"], summary: "Create a floor" } }, async (req, reply) => {
        const body = floorSchema.parse(req.body);
        const block = await prisma.block.findFirst({ where: { id: body.blockId, deletedAt: null } });
        if (!block)
            throw notFound("Block not found");
        try {
            const created = await prisma.floor.create({ data: { ...body, label: body.label ?? null } });
            await auditFromRequest(req)({ action: "FLOOR_CREATED", entity: "Floor", entityId: created.id });
            return reply.status(201).send(created);
        }
        catch (err) {
            if (err.code === "P2002")
                throw conflict("Floor number already exists in block", "FLOOR_EXISTS");
            throw err;
        }
    });
    app.delete("/api/floors/:id", { ...app.requirePermission("buildings:write"), schema: { tags: ["Residents"], summary: "Delete a floor (soft delete)" } }, async (req, reply) => {
        const { id } = req.params;
        const existing = await prisma.floor.findFirst({ where: { id, deletedAt: null } });
        if (!existing)
            throw notFound("Floor not found");
        await prisma.floor.update({ where: { id }, data: { deletedAt: new Date() } });
        await auditFromRequest(req)({ action: "FLOOR_DELETED", entity: "Floor", entityId: id });
        return reply.send({ ok: true });
    });
    app.get("/api/apartments", { ...app.requirePermission("residents:read"), schema: { tags: ["Residents"], summary: "List apartments with residents" } }, async (req, reply) => {
        const q = paginationQuery
            .extend({ blockId: z.string().optional(), buildingId: z.string().optional(), status: z.string().optional() })
            .parse(req.query);
        const where = {
            deletedAt: null,
            ...(q.blockId ? { blockId: q.blockId } : {}),
            ...(q.status ? { status: q.status } : {}),
            ...(q.buildingId ? { block: { buildingId: q.buildingId } } : {}),
            ...(q.q
                ? {
                    OR: [
                        { flatNumber: { contains: q.q } },
                        { residents: { some: { user: { name: { contains: q.q } } } } },
                    ],
                }
                : {}),
        };
        const [total, rows] = await Promise.all([
            prisma.apartment.count({ where }),
            prisma.apartment.findMany({
                where,
                include: {
                    block: { include: { building: { select: { id: true, name: true } } } },
                    floor: { select: { number: true } },
                    residents: {
                        where: { deletedAt: null },
                        include: { user: { select: { id: true, name: true, email: true, phone: true, status: true } } },
                    },
                },
                orderBy: [{ flatNumber: "asc" }],
                skip: offsetOf(q.page, q.limit),
                take: q.limit,
            }),
        ]);
        return reply.send(pageResult(rows, total, q.page, q.limit));
    });
    app.post("/api/apartments", { ...app.requirePermission("buildings:write"), schema: { tags: ["Residents"], summary: "Create an apartment/flat" } }, async (req, reply) => {
        const body = apartmentSchema.parse(req.body);
        const [block, floor] = await Promise.all([
            prisma.block.findFirst({ where: { id: body.blockId, deletedAt: null } }),
            prisma.floor.findFirst({ where: { id: body.floorId, deletedAt: null } }),
        ]);
        if (!block)
            throw notFound("Block not found");
        if (!floor)
            throw notFound("Floor not found");
        if (floor.blockId !== body.blockId)
            throw badRequest("Floor does not belong to this block", "FLOOR_BLOCK_MISMATCH");
        try {
            const created = await prisma.apartment.create({
                data: { ...body, bedroomCount: body.bedroomCount ?? null, area: body.area ?? null, createdBy: req.auth.user.id },
            });
            await auditFromRequest(req)({ action: "APARTMENT_CREATED", entity: "Apartment", entityId: created.id });
            return reply.status(201).send(created);
        }
        catch (err) {
            if (err.code === "P2002")
                throw conflict("Flat number already exists in this block", "FLAT_EXISTS");
            throw err;
        }
    });
    app.put("/api/apartments/:id", { ...app.requirePermission("buildings:write"), schema: { tags: ["Residents"], summary: "Update an apartment" } }, async (req, reply) => {
        const { id } = req.params;
        const body = apartmentSchema.partial().parse(req.body);
        const existing = await prisma.apartment.findFirst({ where: { id, deletedAt: null } });
        if (!existing)
            throw notFound("Apartment not found");
        const updated = await prisma.apartment.update({
            where: { id },
            data: { ...body, updatedBy: req.auth.user.id },
        });
        await auditFromRequest(req)({ action: "APARTMENT_UPDATED", entity: "Apartment", entityId: id });
        return reply.send(updated);
    });
    app.delete("/api/apartments/:id", { ...app.requirePermission("buildings:write"), schema: { tags: ["Residents"], summary: "Deactivate an apartment (soft delete)" } }, async (req, reply) => {
        const { id } = req.params;
        const existing = await prisma.apartment.findFirst({ where: { id, deletedAt: null } });
        if (!existing)
            throw notFound("Apartment not found");
        const activeVisitors = await prisma.visitorInvitation.count({
            where: { apartmentId: id, visitStatus: "INSIDE" },
        });
        if (activeVisitors > 0)
            throw conflict("Visitors are currently inside this apartment's premises scope", "VISITORS_INSIDE");
        await prisma.apartment.update({ where: { id }, data: { deletedAt: new Date(), status: "INACTIVE", updatedBy: req.auth.user.id } });
        await auditFromRequest(req)({ action: "APARTMENT_DELETED", entity: "Apartment", entityId: id });
        return reply.send({ ok: true });
    });
}
