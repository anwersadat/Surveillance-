import { z } from "zod";
import { prisma } from "../db.js";
import { auditFromRequest } from "../lib/audit.js";
import { SETTING_DEFAULTS } from "../lib/settings.js";
import { paginationQuery, offsetOf, pageResult } from "../lib/pagination.js";
export async function notificationRoutes(app) {
    app.get("/api/notifications", {
        preHandler: [app.authenticate],
        schema: { tags: ["Notifications"], summary: "List own notifications" },
    }, async (req, reply) => {
        const q = paginationQuery.extend({ unreadOnly: z.coerce.boolean().optional() }).parse(req.query);
        const where = {
            userId: req.auth.user.id,
            ...(q.unreadOnly ? { readAt: null } : {}),
            ...(q.q ? { OR: [{ title: { contains: q.q } }, { body: { contains: q.q } }] } : {}),
        };
        const [total, unread, rows] = await Promise.all([
            prisma.notification.count({ where }),
            prisma.notification.count({ where: { userId: req.auth.user.id, readAt: null } }),
            prisma.notification.findMany({
                where,
                include: { deliveries: true },
                orderBy: { createdAt: "desc" },
                skip: offsetOf(q.page, q.limit),
                take: q.limit,
            }),
        ]);
        return reply.send({ ...pageResult(rows, total, q.page, q.limit), unread });
    });
    app.post("/api/notifications/:id/read", { preHandler: [app.authenticate], schema: { tags: ["Notifications"], summary: "Mark a notification as read" } }, async (req, reply) => {
        const { id } = req.params;
        const updated = await prisma.notification.updateMany({
            where: { id, userId: req.auth.user.id, readAt: null },
            data: { readAt: new Date() },
        });
        return reply.send({ ok: true, updated: updated.count });
    });
    app.post("/api/notifications/read-all", { preHandler: [app.authenticate], schema: { tags: ["Notifications"], summary: "Mark all notifications as read" } }, async (req, reply) => {
        const updated = await prisma.notification.updateMany({
            where: { userId: req.auth.user.id, readAt: null },
            data: { readAt: new Date() },
        });
        return reply.send({ ok: true, updated: updated.count });
    });
}
export async function settingsRoutes(app) {
    const KNOWN_KEYS = [
        "approvalPolicy",
        "overstayEnabled",
        "overstayGraceMinutes",
        "visitorDataRetentionDays",
        "retentionAnonymizationEnabled",
        "voiceAlertsEnabled",
        "allowInvitationExtension",
        "maxInvitationDaysAhead",
        "invitationDefaultDurationMinutes",
        "invitationArrivalWindowMinutes",
        "requireVehicleNumber",
        "notifyChannels",
        "alertChannels",
        "systemName",
        "integrationApiKey",
    ];
    app.get("/api/settings", { ...app.requirePermission("settings:read"), schema: { tags: ["Admin"], summary: "Read system settings" } }, async (req, reply) => {
        const rows = await prisma.systemSetting.findMany();
        const map = {};
        for (const key of KNOWN_KEYS)
            map[key] = SETTING_DEFAULTS[key] ?? "";
        for (const r of rows)
            if (KNOWN_KEYS.includes(r.key))
                map[r.key] = r.value;
        return reply.send(map);
    });
    app.put("/api/settings", { ...app.requirePermission("settings:write"), schema: { tags: ["Admin"], summary: "Update one or more system settings" } }, async (req, reply) => {
        const body = z.record(z.string(), z.string()).parse(req.body);
        const unknown = Object.keys(body).filter((k) => !KNOWN_KEYS.includes(k));
        if (unknown.length > 0)
            throw new Error(`Unknown settings: ${unknown.join(", ")}`);
        for (const [key, value] of Object.entries(body)) {
            await prisma.systemSetting.upsert({
                where: { key },
                create: { key, value, updatedBy: req.auth.user.id },
                update: { value, updatedBy: req.auth.user.id },
            });
        }
        await auditFromRequest(req)({ action: "SETTINGS_UPDATED", entity: "SystemSetting", metadata: { keys: Object.keys(body) } });
        return reply.send({ ok: true, updated: Object.keys(body) });
    });
    app.get("/api/voice-alerts", { ...app.requirePermission("voice:read"), schema: { tags: ["Admin"], summary: "Read voice alert configurations" } }, async (req, reply) => {
        const rows = await prisma.voiceAlertConfig.findMany({ orderBy: { event: "asc" } });
        return reply.send({ items: rows, total: rows.length });
    });
    app.put("/api/voice-alerts/:event", { ...app.requirePermission("voice:write"), schema: { tags: ["Admin"], summary: "Update a voice alert configuration" } }, async (req, reply) => {
        const { event } = req.params;
        const body = z
            .object({
            message: z.string().min(3).max(400).optional(),
            enabled: z.boolean().optional(),
            priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL", "EMERGENCY"]).optional(),
            voice: z.string().max(30).optional(),
            volume: z.number().min(0).max(1).optional(),
            repeatCount: z.number().int().min(1).max(10).optional(),
            repeatIntervalSeconds: z.number().int().min(1).max(60).optional(),
            targetRoles: z.string().max(120).optional(),
        })
            .parse(req.body);
        const existing = await prisma.voiceAlertConfig.findUnique({ where: { event } });
        if (!existing)
            throw new Error(`Unknown voice event: ${event}`);
        const updated = await prisma.voiceAlertConfig.update({ where: { event }, data: body });
        await auditFromRequest(req)({ action: "VOICE_CONFIG_UPDATED", entity: "VoiceAlertConfig", entityId: event });
        return reply.send(updated);
    });
}
