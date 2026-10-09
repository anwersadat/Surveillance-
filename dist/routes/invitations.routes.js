import { z } from "zod";
import { prisma } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { auditFromRequest } from "../lib/audit.js";
import { generateQRDataUrl } from "../lib/qr.js";
import { paginationQuery } from "../lib/pagination.js";
import { INVITATION_INCLUDE, cancelInvitation, createInvitation, extendInvitation, getInvitationScoped, listInvitations, serializeInvitation, } from "../services/visitor.service.js";
const createSchema = z.object({
    visitorName: z.string().trim().min(2).max(120),
    visitorPhone: z.string().trim().max(30).optional(),
    purpose: z.string().trim().max(200).optional(),
    vehicleNumber: z.string().trim().max(20).optional(),
    notes: z.string().trim().max(500).optional(),
    expectedAt: z.string().min(4),
    durationMinutes: z.coerce.number().int().min(5).max(1440).optional(),
    arrivalWindowMinutes: z.coerce.number().int().min(5).max(720).optional(),
    earlyArrivalMinutes: z.coerce.number().int().min(0).max(240).optional(),
    approvalPolicy: z.enum(["AUTO", "RESIDENT", "SECURITY", "BOTH"]).optional(),
    allowedGateIds: z.array(z.string()).optional(),
    maxUses: z.coerce.number().int().min(1).max(10).optional(),
    apartmentId: z.string().optional(),
    visitorPhotoPath: z.string().optional(),
});
const listQuery = paginationQuery.extend({
    status: z.string().optional(),
    visitStatus: z.string().optional(),
    apartmentId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
});
export async function invitationRoutes(app) {
    app.get("/api/visitors/invitations", { ...app.requirePermission("invitations:read", "invitations:read-own"), schema: { tags: ["Invitations"], summary: "List visitor invitations (scoped to your role)" } }, async (req, reply) => {
        const q = listQuery.parse(req.query);
        const result = await listInvitations(req.auth, q);
        return reply.send(result);
    });
    app.get("/api/visitors/invitations/:id", { ...app.requirePermission("invitations:read", "invitations:read-own"), schema: { tags: ["Invitations"], summary: "Invitation detail (access-scoped)" } }, async (req, reply) => {
        const { id } = req.params;
        const inv = await getInvitationScoped(req.auth, id);
        return reply.send(serializeInvitation(inv));
    });
    app.post("/api/visitors/invitations", {
        ...app.requirePermission("invitations:create"),
        schema: {
            tags: ["Invitations"],
            summary: "Create a visitor invitation (generates visitor code + QR)",
            description: "Creates a secure visitor invitation with a unique VIS-YYYY-XXXXXX code and QR payload. Returns the plain code and QR data URL exactly once for sharing.",
        },
    }, async (req, reply) => {
        const body = createSchema.parse(req.body);
        const { invitation, qrDataUrl } = await createInvitation(req.auth, body, auditFromRequest(req));
        return reply.status(201).send({
            invitation: serializeInvitation(invitation),
            code: invitation.code,
            qrPayload: `SVC:${invitation.code}`,
            qrDataUrl,
            shareUrl: `${(process.env.WEB_ORIGIN ?? "http://localhost:5173")}/invite/${invitation.code}`,
        });
    });
    app.put("/api/visitors/invitations/:id", { ...app.requirePermission("invitations:create", "invitations:read-own"), schema: { tags: ["Invitations"], summary: "Update invitation details before arrival" } }, async (req, reply) => {
        const { id } = req.params;
        const body = z
            .object({
            purpose: z.string().trim().max(200).optional(),
            notes: z.string().trim().max(500).optional(),
            vehicleNumber: z.string().trim().max(20).optional(),
            visitorPhone: z.string().trim().max(30).optional(),
            durationMinutes: z.coerce.number().int().min(5).max(1440).optional(),
        })
            .parse(req.body);
        const inv = await getInvitationScoped(req.auth, id);
        if (inv.visitStatus === "INSIDE" || inv.visitStatus === "EXITED") {
            throw badRequest("Cannot modify a processed invitation", "ALREADY_PROCESSED");
        }
        if (inv.status !== "ACTIVE")
            throw badRequest("Invitation is no longer active", "NOT_ACTIVE");
        const updated = await prisma.visitorInvitation.update({
            where: { id },
            data: {
                ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
                ...(body.notes !== undefined ? { notes: body.notes } : {}),
                ...(body.vehicleNumber !== undefined ? { vehicleNumber: body.vehicleNumber.toUpperCase() } : {}),
                ...(body.visitorPhone !== undefined ? { visitorPhone: body.visitorPhone } : {}),
                ...(body.durationMinutes !== undefined
                    ? {
                        durationMinutes: body.durationMinutes,
                        expectedExitAt: new Date(inv.expectedAt.getTime() + body.durationMinutes * 60_000),
                    }
                    : {}),
                updatedBy: req.auth.user.id,
            },
            include: INVITATION_INCLUDE,
        });
        await auditFromRequest(req)({ action: "INVITATION_UPDATED", entity: "VisitorInvitation", entityId: id });
        return reply.send(serializeInvitation(updated));
    });
    app.delete("/api/visitors/invitations/:id", { ...app.requirePermission("invitations:cancel", "invitations:create"), schema: { tags: ["Invitations"], summary: "Cancel an invitation" } }, async (req, reply) => {
        const { id } = req.params;
        const body = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {});
        const inv = await cancelInvitation(req.auth, id, body.reason, auditFromRequest(req));
        return reply.send(serializeInvitation(inv));
    });
    app.post("/api/visitors/invitations/:id/cancel", { ...app.requirePermission("invitations:cancel", "invitations:create"), schema: { tags: ["Invitations"], summary: "Cancel an invitation (explicit route)" } }, async (req, reply) => {
        const { id } = req.params;
        const body = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {});
        const inv = await cancelInvitation(req.auth, id, body.reason, auditFromRequest(req));
        return reply.send(serializeInvitation(inv));
    });
    app.post("/api/visitors/invitations/:id/extend", { ...app.requirePermission("invitations:create"), schema: { tags: ["Invitations"], summary: "Extend invitation validity" } }, async (req, reply) => {
        const { id } = req.params;
        const body = z.object({ minutes: z.coerce.number().int().min(5).max(1440) }).parse(req.body);
        const inv = await extendInvitation(req.auth, id, body.minutes, auditFromRequest(req));
        return reply.send(serializeInvitation(inv));
    });
    app.get("/api/visitors/invitations/:id/qr", { ...app.requirePermission("invitations:read", "invitations:read-own"), schema: { tags: ["Invitations"], summary: "Regenerate QR data URL for an invitation" } }, async (req, reply) => {
        const { id } = req.params;
        const inv = await getInvitationScoped(req.auth, id);
        const qrDataUrl = await generateQRDataUrl(inv.code);
        await auditFromRequest(req)({ action: "QR_REGENERATED", entity: "VisitorInvitation", entityId: id });
        return reply.send({ code: inv.code, qrPayload: `SVC:${inv.code}`, qrDataUrl });
    });
    app.get("/api/visitors/search", {
        ...app.requirePermission("visitors:view-all"),
        schema: { tags: ["Verification"], summary: "Search visitor records (guard/admin)" },
    }, async (req, reply) => {
        const q = listQuery.parse(req.query);
        if (!q.q)
            throw badRequest("Search query is required", "QUERY_REQUIRED");
        const result = await listInvitations(req.auth, q);
        return reply.send(result);
    });
    app.get("/api/visitors/:id", { ...app.requirePermission("invitations:read", "invitations:read-own"), schema: { tags: ["Verification"], summary: "Visitor record detail with entry/exit history" } }, async (req, reply) => {
        const { id } = req.params;
        const inv = await getInvitationScoped(req.auth, id);
        const [entries, exits] = await Promise.all([
            prisma.visitorEntry.findMany({
                where: { invitationId: id },
                include: { gate: { select: { name: true } }, guard: { select: { name: true } } },
                orderBy: { enteredAt: "desc" },
            }),
            prisma.visitorExit.findMany({
                where: { invitationId: id },
                include: { gate: { select: { name: true } }, guard: { select: { name: true } } },
                orderBy: { exitedAt: "desc" },
            }),
        ]);
        return reply.send({ ...serializeInvitation(inv), entries, exits });
    });
    app.get("/api/visitors", { ...app.requirePermission("visitors:view-all", "invitations:read-own"), schema: { tags: ["Verification"], summary: "All visitor records (scoped by role)" } }, async (req, reply) => {
        const q = listQuery.parse(req.query);
        const result = await listInvitations(req.auth, q);
        return reply.send(result);
    });
}
