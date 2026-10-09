import { z } from "zod";
import { prisma } from "../db.js";
import { conflict, notFound } from "../lib/errors.js";
import { encryptSecret, decryptSecret } from "../lib/encrypt.js";
import { auditFromRequest } from "../lib/audit.js";
import { paginationQuery, offsetOf, pageResult } from "../lib/pagination.js";
const cameraSchema = z.object({
    name: z.string().trim().min(2).max(120),
    location: z.string().trim().max(200).optional(),
    protocol: z.enum(["RTSP", "ONVIF", "HTTP", "VENDOR_API"]).default("RTSP"),
    endpoint: z.string().trim().min(4).max(300),
    username: z.string().max(80).optional(),
    password: z.string().max(200).optional(),
    gateId: z.string().optional(),
    area: z.string().max(120).optional(),
    integrationType: z.string().max(40).default("GENERIC"),
    status: z.enum(["ONLINE", "OFFLINE", "ERROR", "UNKNOWN"]).default("UNKNOWN"),
});
const accessPointSchema = z.object({
    name: z.string().trim().min(2).max(120),
    type: z.enum(["GATE", "DOOR", "TURNSTILE", "BARRIER", "RFID_READER", "QR_SCANNER", "NFC"]).default("GATE"),
    endpoint: z.string().max(300).optional(),
    protocol: z.string().max(40).default("HTTP"),
    gateId: z.string().optional(),
    status: z.enum(["ONLINE", "OFFLINE", "ERROR", "UNKNOWN"]).default("UNKNOWN"),
});
const deviceSchema = z.object({
    name: z.string().trim().min(2).max(120),
    type: z.enum(["SCANNER", "DISPLAY", "SPEAKER", "SIREN", "CONTROLLER"]),
    location: z.string().max(200).optional(),
    endpoint: z.string().max(300).optional(),
    status: z.enum(["ONLINE", "OFFLINE", "ERROR", "UNKNOWN"]).default("UNKNOWN"),
    meta: z.string().max(1000).optional(),
});
function serializeCamera(c) {
    const { passwordEnc, ...rest } = c;
    return { ...rest, credentialsConfigured: Boolean(passwordEnc) };
}
export async function deviceRoutes(app) {
    app.get("/api/cameras", { ...app.requirePermission("cameras:read"), schema: { tags: ["Devices"], summary: "List cameras (credentials never returned)" } }, async (req, reply) => {
        const q = paginationQuery.extend({ status: z.string().optional(), gateId: z.string().optional() }).parse(req.query);
        const where = { deletedAt: null, ...(q.status ? { status: q.status } : {}), ...(q.gateId ? { gateId: q.gateId } : {}) };
        const [total, rows] = await Promise.all([
            prisma.camera.count({ where }),
            prisma.camera.findMany({
                where,
                include: { gate: { select: { id: true, name: true } } },
                orderBy: { name: "asc" },
                skip: offsetOf(q.page, q.limit),
                take: q.limit,
            }),
        ]);
        return reply.send(pageResult(rows.map(serializeCamera), total, q.page, q.limit));
    });
    app.post("/api/cameras", { ...app.requirePermission("cameras:write"), schema: { tags: ["Devices"], summary: "Register a camera (password encrypted at rest)" } }, async (req, reply) => {
        const body = cameraSchema.parse(req.body);
        const created = await prisma.camera.create({
            data: {
                name: body.name,
                location: body.location ?? null,
                protocol: body.protocol,
                endpoint: body.endpoint,
                username: body.username ?? null,
                passwordEnc: body.password ? encryptSecret(body.password) : null,
                gateId: body.gateId ?? null,
                area: body.area ?? null,
                integrationType: body.integrationType,
                status: body.status,
                createdBy: req.auth.user.id,
            },
        });
        await auditFromRequest(req)({ action: "CAMERA_CREATED", entity: "Camera", entityId: created.id });
        return reply.status(201).send(serializeCamera(created));
    });
    app.put("/api/cameras/:id", { ...app.requirePermission("cameras:write"), schema: { tags: ["Devices"], summary: "Update a camera" } }, async (req, reply) => {
        const { id } = req.params;
        const body = cameraSchema.partial().parse(req.body);
        const existing = await prisma.camera.findFirst({ where: { id, deletedAt: null } });
        if (!existing)
            throw notFound("Camera not found");
        const updated = await prisma.camera.update({
            where: { id },
            data: {
                ...(body.name !== undefined ? { name: body.name } : {}),
                ...(body.location !== undefined ? { location: body.location } : {}),
                ...(body.protocol !== undefined ? { protocol: body.protocol } : {}),
                ...(body.endpoint !== undefined ? { endpoint: body.endpoint } : {}),
                ...(body.username !== undefined ? { username: body.username } : {}),
                ...(body.password !== undefined ? { passwordEnc: body.password ? encryptSecret(body.password) : null } : {}),
                ...(body.gateId !== undefined ? { gateId: body.gateId } : {}),
                ...(body.area !== undefined ? { area: body.area } : {}),
                ...(body.status !== undefined ? { status: body.status } : {}),
                updatedBy: req.auth.user.id,
            },
        });
        await auditFromRequest(req)({ action: "CAMERA_UPDATED", entity: "Camera", entityId: id });
        return reply.send(serializeCamera(updated));
    });
    app.delete("/api/cameras/:id", { ...app.requirePermission("cameras:write"), schema: { tags: ["Devices"], summary: "Remove a camera" } }, async (req, reply) => {
        const { id } = req.params;
        const existing = await prisma.camera.findFirst({ where: { id, deletedAt: null } });
        if (!existing)
            throw notFound("Camera not found");
        await prisma.camera.update({ where: { id }, data: { deletedAt: new Date() } });
        await auditFromRequest(req)({ action: "CAMERA_DELETED", entity: "Camera", entityId: id });
        return reply.send({ ok: true });
    });
    app.get("/api/cameras/:id/status", { ...app.requirePermission("cameras:read"), schema: { tags: ["Devices"], summary: "Camera health status" } }, async (req, reply) => {
        const { id } = req.params;
        const camera = await prisma.camera.findFirst({ where: { id, deletedAt: null } });
        if (!camera)
            throw notFound("Camera not found");
        const stale = camera.lastHeartbeatAt ? Date.now() - camera.lastHeartbeatAt.getTime() > 120_000 : true;
        return reply.send({
            id: camera.id,
            status: stale && camera.status === "ONLINE" ? "OFFLINE" : camera.status,
            lastHeartbeatAt: camera.lastHeartbeatAt,
            stale,
        });
    });
    app.post("/api/cameras/:id/heartbeat", { ...app.requirePermission("devices:write"), schema: { tags: ["Devices"], summary: "Report camera heartbeat" } }, async (req, reply) => {
        const { id } = req.params;
        const body = z.object({ status: z.enum(["ONLINE", "OFFLINE", "ERROR"]).default("ONLINE") }).parse(req.body ?? {});
        const existing = await prisma.camera.findFirst({ where: { id, deletedAt: null } });
        if (!existing)
            throw notFound("Camera not found");
        const updated = await prisma.camera.update({ where: { id }, data: { status: body.status, lastHeartbeatAt: new Date() } });
        return reply.send({ ok: true, status: updated.status });
    });
    app.get("/api/access-points", { ...app.requirePermission("devices:read"), schema: { tags: ["Devices"], summary: "List access control points (gates, doors, turnstiles)" } }, async (req, reply) => {
        const rows = await prisma.accessPoint.findMany({
            include: { gate: { select: { id: true, name: true } } },
            orderBy: { name: "asc" },
        });
        return reply.send({ items: rows, total: rows.length });
    });
    app.post("/api/access-points", { ...app.requirePermission("devices:write"), schema: { tags: ["Devices"], summary: "Register an access control point" } }, async (req, reply) => {
        const body = accessPointSchema.parse(req.body);
        const created = await prisma.accessPoint.create({
            data: { ...body, endpoint: body.endpoint ?? null, gateId: body.gateId ?? null, createdBy: req.auth.user.id },
        });
        await auditFromRequest(req)({ action: "ACCESS_POINT_CREATED", entity: "AccessPoint", entityId: created.id });
        return reply.status(201).send(created);
    });
    app.put("/api/access-points/:id", { ...app.requirePermission("devices:write"), schema: { tags: ["Devices"], summary: "Update an access control point" } }, async (req, reply) => {
        const { id } = req.params;
        const body = accessPointSchema.partial().parse(req.body);
        const existing = await prisma.accessPoint.findUnique({ where: { id } });
        if (!existing)
            throw notFound("Access point not found");
        const updated = await prisma.accessPoint.update({ where: { id }, data: { ...body, endpoint: body.endpoint ?? undefined, gateId: body.gateId ?? undefined } });
        return reply.send(updated);
    });
    app.post("/api/access-points/:id/command", {
        ...app.requirePermission("visitors:entry"),
        schema: {
            tags: ["Devices"],
            summary: "Send an open/close command to a gate controller",
            description: "Integration stub: dispatches the command to the registered access-control adapter. Unregistered adapters return 501 and the gate stays closed (fail secure).",
        },
    }, async (req, reply) => {
        const { id } = req.params;
        const body = z.object({ command: z.enum(["OPEN", "CLOSE", "LOCK", "UNLOCK"]), reason: z.string().max(200).optional() }).parse(req.body);
        const ap = await prisma.accessPoint.findUnique({ where: { id } });
        if (!ap)
            throw notFound("Access point not found");
        const { getAccessControlAdapter } = await import("../integrations/accessControl.js");
        const adapter = getAccessControlAdapter(ap.protocol);
        if (!adapter)
            return reply.status(501).send({ error: { code: "ADAPTER_MISSING", message: `No adapter registered for protocol ${ap.protocol}` } });
        const result = await adapter.sendCommand(ap.id, body.command, body.reason ?? null);
        await auditFromRequest(req)({ action: "ACCESS_COMMAND", entity: "AccessPoint", entityId: id, metadata: { command: body.command, result: result.ok ? "ok" : "failed" }, result: result.ok ? "SUCCESS" : "FAILURE" });
        return reply.send(result);
    });
    app.get("/api/devices", { ...app.requirePermission("devices:read"), schema: { tags: ["Devices"], summary: "List security devices (speakers, scanners, controllers)" } }, async (req, reply) => {
        const rows = await prisma.device.findMany({ orderBy: { name: "asc" } });
        return reply.send({ items: rows, total: rows.length });
    });
    app.post("/api/devices", { ...app.requirePermission("devices:write"), schema: { tags: ["Devices"], summary: "Register a security device" } }, async (req, reply) => {
        const body = deviceSchema.parse(req.body);
        const created = await prisma.device.create({ data: { ...body, location: body.location ?? null, endpoint: body.endpoint ?? null, meta: body.meta ?? null } });
        await auditFromRequest(req)({ action: "DEVICE_CREATED", entity: "Device", entityId: created.id });
        return reply.status(201).send(created);
    });
    app.post("/api/devices/:id/heartbeat", { ...app.requirePermission("devices:write"), schema: { tags: ["Devices"], summary: "Report device heartbeat" } }, async (req, reply) => {
        const { id } = req.params;
        const body = z.object({ status: z.enum(["ONLINE", "OFFLINE", "ERROR"]).default("ONLINE") }).parse(req.body ?? {});
        const existing = await prisma.device.findUnique({ where: { id } });
        if (!existing)
            throw notFound("Device not found");
        const updated = await prisma.device.update({ where: { id }, data: { status: body.status, lastHeartbeatAt: new Date() } });
        return reply.send({ ok: true, status: updated.status });
    });
    app.post("/api/devices/:id/decrypt-check", { ...app.requirePermission("devices:write"), schema: { tags: ["Devices"], summary: "Verify a stored encrypted secret round-trips (diagnostics)" } }, async (req, reply) => {
        const body = z.object({ payload: z.string().min(10) }).parse(req.body);
        try {
            const value = decryptSecret(body.payload);
            return reply.send({ ok: true, length: value.length });
        }
        catch {
            throw conflict("Decryption failed", "DECRYPT_FAILED");
        }
    });
}
