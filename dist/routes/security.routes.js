import { z } from "zod";
import { prisma } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { auditFromRequest } from "../lib/audit.js";
import { paginationQuery, offsetOf, pageResult } from "../lib/pagination.js";
import { createAlert, createIncident, serializeIncident } from "../services/alert.service.js";
import { notifyRoles } from "../services/notification.service.js";
import { emitVoiceAlert } from "../services/voice.service.js";
import { ingestDetectorEvent, detectorEventWhere } from "../services/detector.service.js";
import { hub } from "../lib/wsHub.js";
import { setSetting } from "../lib/settings.js";
import { ROLES } from "../lib/rbac.js";
const STAFF = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SECURITY, ROLES.GUARD];
export async function securityRoutes(app) {
    app.get("/api/security/alerts", { ...app.requirePermission("alerts:read"), schema: { tags: ["Security"], summary: "List security alerts (filter by status, priority, type)" } }, async (req, reply) => {
        const q = paginationQuery
            .extend({ status: z.string().optional(), priority: z.string().optional(), type: z.string().optional() })
            .parse(req.query);
        const where = {
            ...(q.status ? { status: q.status } : {}),
            ...(q.priority ? { priority: q.priority } : {}),
            ...(q.type ? { type: q.type } : {}),
            ...(q.q ? { OR: [{ title: { contains: q.q } }, { subjectName: { contains: q.q } }, { code: { contains: q.q.toUpperCase() } }] } : {}),
        };
        const [total, rows] = await Promise.all([
            prisma.securityAlert.count({ where }),
            prisma.securityAlert.findMany({
                where,
                include: {
                    gate: { select: { id: true, name: true } },
                    incident: { select: { id: true, code: true, status: true } },
                    ackedBy: { select: { id: true, name: true } },
                    resolvedBy: { select: { id: true, name: true } },
                },
                orderBy: { createdAt: "desc" },
                skip: offsetOf(q.page, q.limit),
                take: q.limit,
            }),
        ]);
        return reply.send(pageResult(rows, total, q.page, q.limit));
    });
    app.post("/api/security/alerts", { ...app.requirePermission("alerts:read"), schema: { tags: ["Security"], summary: "Manually raise a security alert" } }, async (req, reply) => {
        const body = z
            .object({
            type: z.string().min(2).max(60),
            priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL", "EMERGENCY"]).default("HIGH"),
            title: z.string().min(3).max(160),
            description: z.string().min(3).max(1000),
            gateId: z.string().optional(),
            location: z.string().max(200).optional(),
            subjectName: z.string().max(120).optional(),
            subjectPhone: z.string().max(30).optional(),
            photoPath: z.string().max(300).optional(),
        })
            .parse(req.body);
        const alert = await createAlert({ ...body, notifyAdmins: true });
        await auditFromRequest(req)({ action: "ALERT_CREATED", entity: "SecurityAlert", entityId: alert.id, metadata: { type: alert.type, priority: alert.priority } });
        return reply.status(201).send(alert);
    });
    app.post("/api/security/alerts/:id/acknowledge", { ...app.requirePermission("alerts:acknowledge"), schema: { tags: ["Security"], summary: "Acknowledge an alert" } }, async (req, reply) => {
        const { id } = req.params;
        const alert = await prisma.securityAlert.findUnique({ where: { id } });
        if (!alert)
            throw notFound("Alert not found");
        if (alert.status !== "NEW")
            throw conflict("Alert is not in NEW status", "ALERT_NOT_NEW");
        const updated = await prisma.securityAlert.update({
            where: { id },
            data: { status: "ACKNOWLEDGED", acknowledgedById: req.auth.user.id, acknowledgedAt: new Date() },
        });
        await auditFromRequest(req)({ action: "ALERT_ACKNOWLEDGED", entity: "SecurityAlert", entityId: id });
        hub.publish("staff", { type: "alert-updated", data: { id, status: updated.status } });
        return reply.send(updated);
    });
    app.post("/api/security/alerts/:id/resolve", { ...app.requirePermission("alerts:resolve"), schema: { tags: ["Security"], summary: "Resolve an alert with a resolution note" } }, async (req, reply) => {
        const { id } = req.params;
        const body = z.object({ resolution: z.string().min(3).max(500) }).parse(req.body);
        const alert = await prisma.securityAlert.findUnique({ where: { id } });
        if (!alert)
            throw notFound("Alert not found");
        if (["RESOLVED", "CLOSED"].includes(alert.status))
            throw conflict("Alert already resolved", "ALERT_CLOSED");
        const updated = await prisma.securityAlert.update({
            where: { id },
            data: { status: "RESOLVED", resolvedById: req.auth.user.id, resolvedAt: new Date(), resolution: body.resolution },
        });
        await auditFromRequest(req)({ action: "ALERT_RESOLVED", entity: "SecurityAlert", entityId: id, metadata: { resolution: body.resolution } });
        hub.publish("staff", { type: "alert-updated", data: { id, status: updated.status } });
        return reply.send(updated);
    });
    app.get("/api/security/incidents", { ...app.requirePermission("incidents:read"), schema: { tags: ["Security"], summary: "List security incidents" } }, async (req, reply) => {
        const q = paginationQuery
            .extend({ status: z.string().optional(), priority: z.string().optional() })
            .parse(req.query);
        const where = {
            ...(q.status ? { status: q.status } : {}),
            ...(q.priority ? { priority: q.priority } : {}),
            ...(q.q ? { OR: [{ title: { contains: q.q } }, { code: { contains: q.q.toUpperCase() } }, { subjectName: { contains: q.q } }] } : {}),
        };
        const [total, rows] = await Promise.all([
            prisma.securityIncident.count({ where }),
            prisma.securityIncident.findMany({
                where,
                include: {
                    gate: { select: { id: true, name: true } },
                    reportedBy: { select: { id: true, name: true } },
                    closedBy: { select: { id: true, name: true } },
                    alerts: { select: { id: true, code: true, status: true, priority: true } },
                },
                orderBy: { createdAt: "desc" },
                skip: offsetOf(q.page, q.limit),
                take: q.limit,
            }),
        ]);
        return reply.send(pageResult(rows, total, q.page, q.limit));
    });
    app.post("/api/security/incidents", { ...app.requirePermission("incidents:write"), schema: { tags: ["Security"], summary: "Create a security incident" } }, async (req, reply) => {
        const body = z
            .object({
            type: z.string().min(2).max(60),
            priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL", "EMERGENCY"]).default("HIGH"),
            title: z.string().min(3).max(160),
            description: z.string().min(3).max(2000),
            location: z.string().max(200).optional(),
            gateId: z.string().optional(),
            subjectName: z.string().max(120).optional(),
            subjectPhone: z.string().max(30).optional(),
            photoPath: z.string().max(300).optional(),
            assignedGuardId: z.string().optional(),
            alertId: z.string().optional(),
        })
            .parse(req.body);
        const incident = await createIncident({
            ...body,
            location: body.location ?? null,
            gateId: body.gateId ?? null,
            subjectName: body.subjectName ?? null,
            subjectPhone: body.subjectPhone ?? null,
            photoPath: body.photoPath ?? null,
            assignedGuardId: body.assignedGuardId ?? null,
            alertId: body.alertId ?? null,
            reportedById: req.auth.user.id,
        });
        await auditFromRequest(req)({ action: "INCIDENT_CREATED", entity: "SecurityIncident", entityId: incident.id });
        return reply.status(201).send(incident);
    });
    app.put("/api/security/incidents/:id", { ...app.requirePermission("incidents:write", "incidents:close"), schema: { tags: ["Security"], summary: "Update incident status, actions and resolution" } }, async (req, reply) => {
        const { id } = req.params;
        const body = z
            .object({
            status: z.enum(["NEW", "ACKNOWLEDGED", "INVESTIGATING", "RESOLVED", "CLOSED"]).optional(),
            actionsTaken: z.string().max(2000).optional(),
            resolution: z.string().max(1000).optional(),
            assignedGuardId: z.string().optional(),
            description: z.string().max(2000).optional(),
        })
            .parse(req.body);
        const incident = await prisma.securityIncident.findUnique({ where: { id } });
        if (!incident)
            throw notFound("Incident not found");
        if (body.status === "CLOSED" && !req.auth.permissions.includes("incidents:close")) {
            throw badRequest("Closing incidents requires incidents:close permission", "MISSING_PERMISSION");
        }
        const closing = body.status === "CLOSED";
        const updated = await prisma.securityIncident.update({
            where: { id },
            data: {
                ...(body.status ? { status: body.status } : {}),
                ...(body.actionsTaken !== undefined ? { actionsTaken: body.actionsTaken } : {}),
                ...(body.resolution !== undefined ? { resolution: body.resolution } : {}),
                ...(body.assignedGuardId !== undefined ? { assignedGuardId: body.assignedGuardId } : {}),
                ...(body.description !== undefined ? { description: body.description } : {}),
                ...(closing ? { closedById: req.auth.user.id, closedAt: new Date(), status: "CLOSED" } : {}),
            },
        });
        if (closing) {
            await prisma.securityAlert.updateMany({
                where: { incidentId: id, status: { in: ["NEW", "ACKNOWLEDGED"] } },
                data: { status: "CLOSED", resolvedById: req.auth.user.id, resolvedAt: new Date(), resolution: body.resolution ?? "Incident closed" },
            });
        }
        await auditFromRequest(req)({ action: closing ? "INCIDENT_CLOSED" : "INCIDENT_UPDATED", entity: "SecurityIncident", entityId: id, metadata: { status: updated.status } });
        hub.publish("staff", { type: "incident", data: { action: "updated", incident: serializeIncident(updated) } });
        return reply.send(updated);
    });
    app.get("/api/security/watchlist", { ...app.requirePermission("watchlist:read"), schema: { tags: ["Security"], summary: "List watchlist/blocked entries" } }, async (req, reply) => {
        const q = paginationQuery.extend({ status: z.string().optional(), level: z.string().optional() }).parse(req.query);
        const where = {
            ...(q.status ? { status: q.status } : {}),
            ...(q.level ? { level: q.level } : {}),
            ...(q.q ? { OR: [{ name: { contains: q.q } }, { phone: { contains: q.q } }, { vehicle: { contains: q.q } }] } : {}),
        };
        const [total, rows] = await Promise.all([
            prisma.watchlistEntry.count({ where }),
            prisma.watchlistEntry.findMany({
                where,
                include: { createdBy: { select: { id: true, name: true } } },
                orderBy: { createdAt: "desc" },
                skip: offsetOf(q.page, q.limit),
                take: q.limit,
            }),
        ]);
        return reply.send(pageResult(rows, total, q.page, q.limit));
    });
    app.post("/api/security/watchlist", { ...app.requirePermission("watchlist:manage"), schema: { tags: ["Security"], summary: "Add a visitor to the security watchlist" } }, async (req, reply) => {
        const body = z
            .object({
            name: z.string().trim().max(120).optional(),
            phone: z.string().trim().max(30).optional(),
            vehicle: z.string().trim().max(20).optional(),
            reason: z.string().trim().min(3).max(300),
            level: z.enum(["BLOCKED", "WATCHLIST", "RESTRICTED"]).default("WATCHLIST"),
        })
            .parse(req.body);
        if (!body.name && !body.phone && !body.vehicle) {
            throw badRequest("Provide at least a name, phone or vehicle", "IDENTIFIER_REQUIRED");
        }
        const created = await prisma.watchlistEntry.create({
            data: { ...body, createdById: req.auth.user.id },
        });
        await auditFromRequest(req)({ action: "WATCHLIST_ADDED", entity: "WatchlistEntry", entityId: created.id, metadata: { level: body.level } });
        return reply.status(201).send(created);
    });
    app.put("/api/security/watchlist/:id", { ...app.requirePermission("watchlist:manage"), schema: { tags: ["Security"], summary: "Update a watchlist entry" } }, async (req, reply) => {
        const { id } = req.params;
        const body = z
            .object({
            reason: z.string().trim().min(3).max(300).optional(),
            level: z.enum(["BLOCKED", "WATCHLIST", "RESTRICTED"]).optional(),
            status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
        })
            .parse(req.body);
        const existing = await prisma.watchlistEntry.findUnique({ where: { id } });
        if (!existing)
            throw notFound("Watchlist entry not found");
        const updated = await prisma.watchlistEntry.update({ where: { id }, data: body });
        await auditFromRequest(req)({ action: "WATCHLIST_UPDATED", entity: "WatchlistEntry", entityId: id });
        return reply.send(updated);
    });
    app.delete("/api/security/watchlist/:id", { ...app.requirePermission("watchlist:manage"), schema: { tags: ["Security"], summary: "Remove a watchlist entry" } }, async (req, reply) => {
        const { id } = req.params;
        const existing = await prisma.watchlistEntry.findUnique({ where: { id } });
        if (!existing)
            throw notFound("Watchlist entry not found");
        await prisma.watchlistEntry.update({ where: { id }, data: { status: "INACTIVE" } });
        await auditFromRequest(req)({ action: "WATCHLIST_REMOVED", entity: "WatchlistEntry", entityId: id });
        return reply.send({ ok: true });
    });
    app.post("/api/security/lockdown", {
        ...app.requirePermission("lockdown:manage"),
        schema: {
            tags: ["Security"],
            summary: "Activate emergency lockdown",
            description: "Stops new visitor approvals and entries, notifies all staff and triggers the emergency voice alert.",
        },
    }, async (req, reply) => {
        const body = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {});
        const current = await prisma.systemSetting.findUnique({ where: { key: "lockdownActive" } });
        if (current?.value === "true")
            throw conflict("Lockdown is already active", "LOCKDOWN_ACTIVE");
        await setSetting("lockdownActive", "true", req.auth.user.id);
        const event = await prisma.emergencyEvent.create({
            data: {
                type: "LOCKDOWN_ACTIVATE",
                reason: body.reason ?? "Emergency lockdown activated",
                activatedById: req.auth.user.id,
            },
        });
        await auditFromRequest(req)({ action: "LOCKDOWN_ACTIVATED", entity: "EmergencyEvent", entityId: event.id, metadata: { reason: body.reason } });
        hub.broadcast({ type: "lockdown", data: { active: true, reason: body.reason ?? null, at: new Date().toISOString() } });
        await emitVoiceAlert("LOCKDOWN");
        await notifyRoles(STAFF, {
            type: "LOCKDOWN",
            title: "EMERGENCY LOCKDOWN ACTIVE",
            body: `Emergency lockdown has been activated.${body.reason ? ` Reason: ${body.reason}` : ""} All visitor approvals and entries are suspended.`,
            priority: "EMERGENCY",
            data: { eventId: event.id },
        });
        await createAlert({
            type: "LOCKDOWN",
            priority: "EMERGENCY",
            title: "Emergency lockdown activated",
            description: body.reason ?? "Emergency lockdown activated by administrator.",
            notifyAdmins: false,
            voiceEvent: null,
        });
        return reply.send({ ok: true, active: true, eventId: event.id });
    });
    app.post("/api/security/lockdown/release", { ...app.requirePermission("lockdown:manage"), schema: { tags: ["Security"], summary: "Release emergency lockdown" } }, async (req, reply) => {
        const body = z.object({ notes: z.string().max(300).optional() }).parse(req.body ?? {});
        const current = await prisma.systemSetting.findUnique({ where: { key: "lockdownActive" } });
        if (current?.value !== "true")
            throw conflict("No active lockdown", "NO_LOCKDOWN");
        await setSetting("lockdownActive", "false", req.auth.user.id);
        const event = await prisma.emergencyEvent.create({
            data: {
                type: "LOCKDOWN_RELEASE",
                notes: body.notes ?? null,
                activatedById: req.auth.user.id,
                releasedById: req.auth.user.id,
                releasedAt: new Date(),
            },
        });
        await auditFromRequest(req)({ action: "LOCKDOWN_RELEASED", entity: "EmergencyEvent", entityId: event.id, metadata: { notes: body.notes } });
        hub.broadcast({ type: "lockdown", data: { active: false, at: new Date().toISOString() } });
        await notifyRoles(STAFF, {
            type: "LOCKDOWN",
            title: "Lockdown released",
            body: "Emergency lockdown has been released. Normal visitor operations resume.",
            priority: "HIGH",
            data: { eventId: event.id },
        });
        return reply.send({ ok: true, active: false, eventId: event.id });
    });
    app.get("/api/security/emergency/events", { ...app.requirePermission("alerts:read"), schema: { tags: ["Security"], summary: "Emergency event history (lockdowns)" } }, async (req, reply) => {
        const rows = await prisma.emergencyEvent.findMany({ orderBy: { activatedAt: "desc" }, take: 100 });
        return reply.send({ items: rows, total: rows.length });
    });
    app.get("/api/security/status", { ...app.requirePermission("alerts:read"), schema: { tags: ["Security"], summary: "Current lockdown and alert status" } }, async (req, reply) => {
        const lockdown = await prisma.systemSetting.findUnique({ where: { key: "lockdownActive" } });
        const activeAlerts = await prisma.securityAlert.count({ where: { status: { in: ["NEW", "ACKNOWLEDGED"] } } });
        return reply.send({
            lockdownActive: lockdown?.value === "true",
            activeAlerts,
        });
    });
    const detectorSchema = z.object({
        source: z.enum(["CCTV", "AI", "ACCESS_CONTROL", "MANUAL"]).default("CCTV"),
        type: z.enum(["UNKNOWN_PERSON", "PERSON_DETECTED", "LOITERING", "INTRUSION", "CROWD", "LICENSE_PLATE", "RESTRICTED_AREA"]),
        area: z.string().max(120).optional(),
        gateId: z.string().optional(),
        cameraId: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
    });
    app.post("/api/integrations/detector-events", {
        schema: {
            tags: ["Devices"],
            summary: "Ingest an AI/CCTV person-detection event",
            description: "Integration endpoint for cameras and AI analytics. UNKNOWN_PERSON events without a matching inside-entry create a CRITICAL alert, incident and voice warning. AI events never grant access directly. Authenticate with a bearer token or x-api-key.",
            security: [{ bearerAuth: [] }, { apiKey: [] }],
        },
        config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    }, async (req, reply) => {
        const apiKey = req.headers["x-api-key"];
        const settingsKey = (await prisma.systemSetting.findUnique({ where: { key: "integrationApiKey" } }))?.value;
        let authorized = false;
        if (typeof apiKey === "string" && settingsKey && apiKey === settingsKey) {
            authorized = true;
        }
        else {
            const header = req.headers.authorization;
            if (header?.startsWith("Bearer ")) {
                try {
                    const payload = app.jwt.verify(header.slice(7));
                    const user = await prisma.user.findFirst({
                        where: { id: payload.sub, status: "ACTIVE", deletedAt: null },
                        select: { role: true },
                    });
                    if (user) {
                        const { permissionsForRole } = await import("../lib/rbac.js");
                        if (permissionsForRole(user.role).includes("detector:ingest"))
                            authorized = true;
                    }
                }
                catch {
                    authorized = false;
                }
            }
        }
        if (!authorized)
            throw badRequest("Invalid integration credentials", "UNAUTHORIZED_INTEGRATION");
        const body = detectorSchema.parse(req.body);
        const event = await ingestDetectorEvent({
            source: body.source,
            type: body.type,
            area: body.area ?? null,
            gateId: body.gateId ?? null,
            cameraId: body.cameraId ?? null,
            confidence: body.confidence ?? null,
            payload: body.payload ?? null,
        });
        return reply.status(201).send(event);
    });
    app.get("/api/security/detector-events", { ...app.requirePermission("incidents:read"), schema: { tags: ["Devices"], summary: "List AI/CCTV detector events" } }, async (req, reply) => {
        const rows = await detectorEventWhere({});
        return reply.send({ items: rows, total: rows.length });
    });
}
