import { z } from "zod";
import { prisma } from "../db.js";
import { auditFromRequest } from "../lib/audit.js";
import { paginationQuery } from "../lib/pagination.js";
import { decideApproval, getCurrentlyInside, getPendingApprovals, recordEntry, recordExit, verifyVisitor, } from "../services/verification.service.js";
const verifySchema = z.object({
    code: z.string().trim().min(3).max(64),
    gateId: z.string().optional(),
    deviceInfo: z.string().max(200).optional(),
    source: z.enum(["QR", "CODE"]).default("CODE"),
});
const entrySchema = z.object({
    gateId: z.string().min(1),
    deviceInfo: z.string().max(200).optional(),
    photoPath: z.string().max(300).optional(),
    vehicleNumber: z.string().max(20).optional(),
    source: z.enum(["QR", "CODE", "API"]).default("CODE"),
});
const exitSchema = z.object({
    gateId: z.string().min(1),
    deviceInfo: z.string().max(200).optional(),
});
const decisionSchema = z.object({
    type: z.enum(["RESIDENT", "SECURITY"]),
    decision: z.enum(["APPROVED", "REJECTED"]),
    reason: z.string().max(300).optional(),
});
async function handleVerify(req, reply, source) {
    const body = verifySchema.parse({ ...req.body, source });
    const auth = req.auth;
    const result = await verifyVisitor({
        code: body.code,
        gateId: body.gateId ?? null,
        guardUserId: auth.user.id,
        guardName: auth.user.name,
        deviceInfo: body.deviceInfo ?? null,
        source,
    });
    await auditFromRequest(req)({
        action: source === "QR" ? "QR_SCANNED" : "CODE_VERIFIED",
        entity: "VisitorInvitation",
        entityId: result.ok ? result.invitation.id : undefined,
        result: result.ok ? "SUCCESS" : "FAILURE",
        metadata: {
            code: body.code.slice(0, 16),
            gateId: body.gateId,
            outcome: result.ok ? "VERIFIED" : result.reason,
            ...(result.ok ? {} : { alertId: result.alertId }),
        },
    });
    if (result.ok) {
        return reply.send({
            verified: true,
            banner: "VISITOR VERIFIED",
            ...result,
        });
    }
    return reply.status(200).send({
        verified: false,
        banner: "UNAUTHORIZED / UNVERIFIED VISITOR",
        ...result,
    });
}
export async function visitorFlowRoutes(app) {
    app.post("/api/visitors/verify-code", {
        ...app.requirePermission("visitors:verify"),
        schema: {
            tags: ["Verification"],
            summary: "Verify a manually entered visitor code",
            description: "Performs the full 11-point verification: existence, validity, expiry, cancellation, resident, apartment, permitted window, prior entry, usage limits, watchlist and security rules. Failures return 200 with verified=false and raise a security alert.",
        },
    }, async (req, reply) => handleVerify(req, reply, "CODE"));
    app.post("/api/visitors/verify-qr", {
        ...app.requirePermission("visitors:verify"),
        schema: {
            tags: ["Verification"],
            summary: "Verify a scanned QR payload",
            description: "Accepts the raw QR payload (SVC:VIS-YYYY-XXXXXX) or a bare visitor code.",
        },
    }, async (req, reply) => handleVerify(req, reply, "QR"));
    app.post("/api/visitors/:id/approve", {
        ...app.requirePermission("approvals:resident", "approvals:security"),
        schema: { tags: ["Verification"], summary: "Approve a pending visitor entry request" },
    }, async (req, reply) => {
        const { id } = req.params;
        const body = decisionSchema.parse({ ...req.body, decision: "APPROVED" });
        const inv = await decideApproval(req.auth, id, body.type, body.decision, body.reason);
        await auditFromRequest(req)({
            action: "ENTRY_APPROVED",
            entity: "VisitorInvitation",
            entityId: id,
            metadata: { approvalType: body.type },
        });
        return reply.send(inv);
    });
    app.post("/api/visitors/:id/reject", {
        ...app.requirePermission("approvals:resident", "approvals:security"),
        schema: { tags: ["Verification"], summary: "Reject a pending visitor entry request" },
    }, async (req, reply) => {
        const { id } = req.params;
        const body = decisionSchema.parse({ ...req.body, decision: "REJECTED" });
        const inv = await decideApproval(req.auth, id, body.type, body.decision, body.reason);
        await auditFromRequest(req)({
            action: "ENTRY_REJECTED",
            entity: "VisitorInvitation",
            entityId: id,
            metadata: { approvalType: body.type, reason: body.reason },
        });
        return reply.send(inv);
    });
    app.post("/api/visitors/:id/entry", {
        ...app.requirePermission("visitors:entry"),
        schema: {
            tags: ["Verification"],
            summary: "Record authorized entry through a gate",
            description: "Validates approval state, visiting window and lockdown, then marks the visitor INSIDE and notifies the resident.",
        },
    }, async (req, reply) => {
        const { id } = req.params;
        const body = entrySchema.parse(req.body);
        const result = await recordEntry({
            invitationId: id,
            gateId: body.gateId,
            guardUserId: req.auth.user.id,
            deviceInfo: body.deviceInfo ?? null,
            photoPath: body.photoPath ?? null,
            source: body.source,
            vehicleNumber: body.vehicleNumber ?? null,
        });
        await auditFromRequest(req)({
            action: "VISITOR_ENTRY",
            entity: "VisitorInvitation",
            entityId: id,
            metadata: { gateId: body.gateId, entryId: result.entry.id, source: body.source },
        });
        return reply.send({ message: "ENTRY APPROVED", ...result });
    });
    app.post("/api/visitors/:id/exit", {
        ...app.requirePermission("visitors:exit"),
        schema: { tags: ["Verification"], summary: "Record visitor exit" },
    }, async (req, reply) => {
        const { id } = req.params;
        const body = exitSchema.parse(req.body);
        const result = await recordExit({
            invitationId: id,
            gateId: body.gateId,
            guardUserId: req.auth.user.id,
            deviceInfo: body.deviceInfo ?? null,
        });
        await auditFromRequest(req)({
            action: "VISITOR_EXIT",
            entity: "VisitorInvitation",
            entityId: id,
            metadata: { gateId: body.gateId, exitId: result.exit.id },
        });
        return reply.send(result);
    });
    app.get("/api/visitors/currently-inside", {
        ...app.requirePermission("visitors:view-all", "invitations:read-own"),
        schema: { tags: ["Verification"], summary: "Real-time list of visitors inside the premises" },
    }, async (req, reply) => {
        const q = paginationQuery.parse(req.query);
        const result = await getCurrentlyInside(req.auth, q);
        return reply.send(result);
    });
    app.get("/api/visitors/pending-approvals", {
        ...app.requirePermission("approvals:view"),
        schema: { tags: ["Verification"], summary: "Invitations awaiting approval" },
    }, async (req, reply) => {
        const items = await getPendingApprovals(req.auth);
        return reply.send({ items, total: items.length });
    });
    app.get("/api/visitors/stats/summary", {
        ...app.requirePermission("visitors:view-all"),
        schema: { tags: ["Verification"], summary: "Quick visitor counters for guard screens" },
    }, async (req, reply) => {
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const [todayTotal, inside, pending, exited] = await Promise.all([
            prisma.visitorInvitation.count({ where: { createdAt: { gte: today } } }),
            prisma.visitorInvitation.count({ where: { visitStatus: "INSIDE" } }),
            prisma.visitorApproval.count({ where: { status: "PENDING" } }),
            prisma.visitorInvitation.count({
                where: { visitStatus: "EXITED", updatedAt: { gte: today } },
            }),
        ]);
        return reply.send({ todayTotal, inside, pending, exited });
    });
}
