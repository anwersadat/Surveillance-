import { prisma } from "../db.js";
import { normalizeVisitorCode } from "../lib/codes.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { getApprovalPolicy, getIntSetting, isLockdownActive } from "../lib/settings.js";
import { hub } from "../lib/wsHub.js";
import { createAlert } from "./alert.service.js";
import { notify } from "./notification.service.js";
import { emitVoiceAlert } from "./voice.service.js";
import { INVITATION_INCLUDE, getInvitationScoped, serializeInvitation, } from "./visitor.service.js";
import { offsetOf, pageResult } from "../lib/pagination.js";
const REASON_MESSAGES = {
    NOT_FOUND: "Visitor code not recognized.",
    CANCELLED: "This invitation has been cancelled by the resident.",
    REJECTED: "Entry for this visitor was rejected.",
    EXPIRED: "This invitation has expired.",
    EXHAUSTED: "This invitation has already been used the maximum number of times.",
    ALREADY_INSIDE: "This visitor is already inside the premises.",
    ALREADY_EXITED: "This visitor has already exited the premises.",
    OUTSIDE_WINDOW: "This visit is outside the permitted visiting period.",
    RESIDENT_INACTIVE: "The hosting resident account is inactive.",
    APARTMENT_INACTIVE: "The hosting apartment is inactive.",
    GATE_NOT_ALLOWED: "This visitor is not permitted through this gate.",
    BLOCKED: "This visitor is blocked from entering the premises.",
    LOCKDOWN_ACTIVE: "Emergency lockdown is active. Entry is suspended.",
};
const REASON_ALERT_TYPE = {
    NOT_FOUND: "INVALID_CODE",
    CANCELLED: "INVALID_CODE",
    REJECTED: "UNAUTHORIZED_VISITOR",
    EXPIRED: "EXPIRED_CODE",
    EXHAUSTED: "EXPIRED_CODE",
    ALREADY_INSIDE: "ALREADY_INSIDE",
    OUTSIDE_WINDOW: "UNAUTHORIZED_VISITOR",
    RESIDENT_INACTIVE: "UNAUTHORIZED_VISITOR",
    APARTMENT_INACTIVE: "UNAUTHORIZED_VISITOR",
    GATE_NOT_ALLOWED: "UNAUTHORIZED_VISITOR",
    BLOCKED: "WATCHLIST_MATCH",
};
const REASON_PRIORITY = {
    NOT_FOUND: "HIGH",
    CANCELLED: "HIGH",
    REJECTED: "CRITICAL",
    EXPIRED: "MEDIUM",
    EXHAUSTED: "MEDIUM",
    ALREADY_INSIDE: "MEDIUM",
    OUTSIDE_WINDOW: "HIGH",
    RESIDENT_INACTIVE: "HIGH",
    APARTMENT_INACTIVE: "HIGH",
    GATE_NOT_ALLOWED: "HIGH",
    BLOCKED: "CRITICAL",
};
export function requiredApprovalTypes(policy) {
    switch (policy) {
        case "AUTO":
            return [];
        case "RESIDENT":
            return ["RESIDENT"];
        case "SECURITY":
            return ["SECURITY"];
        case "BOTH":
            return ["RESIDENT", "SECURITY"];
        default:
            return ["RESIDENT"];
    }
}
export function computeApprovalState(inv, policy) {
    const required = requiredApprovalTypes(policy);
    const approved = inv.approvals.filter((a) => a.status === "APPROVED").map((a) => a.type);
    const rejected = inv.approvals.some((a) => a.status === "REJECTED");
    const pending = required.filter((t) => !approved.includes(t));
    return { required, approved, rejected, pending, complete: rejected ? false : pending.length === 0 };
}
async function ensureApprovalRows(inv, required) {
    for (const type of required) {
        await prisma.visitorApproval.upsert({
            where: { invitationId_type: { invitationId: inv.id, type } },
            create: { invitationId: inv.id, type, status: "PENDING" },
            update: {},
        });
    }
}
function upgradePolicy(policy) {
    if (policy === "AUTO")
        return "SECURITY";
    if (policy === "SECURITY")
        return "BOTH";
    if (policy === "RESIDENT")
        return "BOTH";
    return policy;
}
function withinWindow(inv, now, earlyGraceMs = 15 * 60_000) {
    return now.getTime() >= inv.arriveFrom.getTime() - earlyGraceMs && now.getTime() <= inv.arriveUntil.getTime();
}
export async function verifyVisitor(input) {
    const code = normalizeVisitorCode(input.code);
    const now = new Date();
    if (!code) {
        return { ok: false, reason: "NOT_FOUND", message: REASON_MESSAGES.NOT_FOUND };
    }
    if (await isLockdownActive()) {
        return { ok: false, reason: "LOCKDOWN_ACTIVE", message: REASON_MESSAGES.LOCKDOWN_ACTIVE };
    }
    const inv = await prisma.visitorInvitation.findUnique({
        where: { code },
        include: INVITATION_INCLUDE,
    });
    if (!inv || inv.deletedAt) {
        return await failVerification(input, null, "NOT_FOUND", now, `Attempted code: ${code.slice(0, 12)}`);
    }
    if (inv.status === "CANCELLED") {
        return await failVerification(input, inv, "CANCELLED", now);
    }
    if (inv.status === "REJECTED" || inv.visitStatus === "DENIED" || inv.visitStatus === "REJECTED") {
        return await failVerification(input, inv, "REJECTED", now);
    }
    if (inv.expiresAt.getTime() < now.getTime() || inv.status === "EXPIRED") {
        if (inv.status === "ACTIVE") {
            await prisma.visitorInvitation.update({ where: { id: inv.id }, data: { status: "EXPIRED" } });
        }
        return await failVerification(input, inv, "EXPIRED", now);
    }
    if (inv.visitStatus === "INSIDE") {
        return await failVerification(input, inv, "ALREADY_INSIDE", now);
    }
    if (inv.usedCount >= inv.maxUses) {
        return await failVerification(input, inv, "EXHAUSTED", now);
    }
    if (!withinWindow(inv, now)) {
        return await failVerification(input, inv, "OUTSIDE_WINDOW", now);
    }
    const residentUser = inv.resident.user;
    if (inv.resident.status !== "ACTIVE" || !residentUser || residentUser.status !== "ACTIVE") {
        return await failVerification(input, inv, "RESIDENT_INACTIVE", now);
    }
    if (inv.apartment.status !== "ACTIVE") {
        return await failVerification(input, inv, "APARTMENT_INACTIVE", now);
    }
    if (input.gateId && inv.allowedGateIds) {
        const allowed = inv.allowedGateIds.split(",").map((g) => g.trim()).filter(Boolean);
        if (allowed.length > 0 && !allowed.includes(input.gateId)) {
            return await failVerification(input, inv, "GATE_NOT_ALLOWED", now);
        }
    }
    const watchEntries = await prisma.watchlistEntry.findMany({ where: { status: "ACTIVE" } });
    const nameMatch = (n) => !!n && !!inv.visitorName && n.trim().toLowerCase() === inv.visitorName.trim().toLowerCase();
    const phoneMatch = (p) => !!p && !!inv.visitorPhone && p.replace(/\D/g, "") === inv.visitorPhone.replace(/\D/g, "");
    const matched = watchEntries.filter((w) => phoneMatch(w.phone) || nameMatch(w.name));
    if (matched.some((w) => w.level === "BLOCKED" || w.level === "RESTRICTED")) {
        await prisma.visitorInvitation.update({ where: { id: inv.id }, data: { visitStatus: "BLOCKED" } });
        return await failVerification(input, inv, "BLOCKED", now, matched[0].reason);
    }
    const watchlisted = matched.length > 0;
    let policy = inv.approvalPolicy ?? (await getApprovalPolicy());
    if (!["AUTO", "RESIDENT", "SECURITY", "BOTH"].includes(policy))
        policy = "RESIDENT";
    if (watchlisted)
        policy = upgradePolicy(policy);
    const required = requiredApprovalTypes(policy);
    if (policy !== inv.approvalPolicy) {
        await prisma.visitorInvitation.update({ where: { id: inv.id }, data: { approvalPolicy: policy } });
        inv.approvalPolicy = policy;
    }
    await ensureApprovalRows(inv, required);
    const state = computeApprovalState(inv, policy);
    if (state.rejected) {
        return await failVerification(input, inv, "REJECTED", now);
    }
    const fresh = await prisma.visitorInvitation.findUnique({
        where: { id: inv.id },
        include: INVITATION_INCLUDE,
    });
    if (!fresh)
        return await failVerification(input, inv, "NOT_FOUND", now);
    const state2 = computeApprovalState(fresh, policy);
    let visitStatus = fresh.visitStatus;
    if (state2.complete) {
        visitStatus = "APPROVED";
    }
    else {
        visitStatus = "AWAITING_APPROVAL";
        for (const type of state2.pending) {
            const row = fresh.approvals.find((a) => a.type === type);
            if (row && row.status === "PENDING" && !row.decidedAt) {
                if (type === "RESIDENT") {
                    await notify({
                        userId: fresh.resident.userId,
                        type: "VISITOR_APPROVAL_REQUEST",
                        title: "Visitor waiting at the gate",
                        body: `Your visitor ${fresh.visitorName} is waiting for entry approval.${input.gateId ? "" : ""} Approve or reject from your dashboard.`,
                        priority: "MEDIUM",
                        data: { invitationId: fresh.id, gateId: input.gateId, code: fresh.code },
                    });
                    hub.toUser(fresh.resident.userId, {
                        type: "approval-request",
                        data: { invitationId: fresh.id, code: fresh.code, visitorName: fresh.visitorName },
                    });
                }
                else {
                    await notify({
                        userId: fresh.resident.userId,
                        type: "VISITOR_APPROVAL_REQUEST",
                        title: "Security approval required",
                        body: `Visitor ${fresh.visitorName} requires security approval before entry.`,
                        priority: "HIGH",
                        data: { invitationId: fresh.id },
                    });
                }
            }
        }
        hub.publish("guards", {
            type: "approval-pending",
            data: { invitationId: fresh.id, code: fresh.code, visitorName: fresh.visitorName, pending: state2.pending },
        });
        hub.publish("security", {
            type: "approval-pending",
            data: { invitationId: fresh.id, code: fresh.code, visitorName: fresh.visitorName, pending: state2.pending },
        });
    }
    if (fresh.visitStatus !== visitStatus) {
        await prisma.visitorInvitation.update({ where: { id: fresh.id }, data: { visitStatus } });
        fresh.visitStatus = visitStatus;
    }
    if (watchlisted) {
        await createAlert({
            type: "WATCHLIST_MATCH",
            priority: "HIGH",
            title: "Watchlisted visitor at gate",
            description: `${fresh.visitorName} matches an active security watchlist entry and is requesting entry.`,
            gateId: input.gateId ?? null,
            subjectName: fresh.visitorName,
            subjectPhone: fresh.visitorPhone,
            invitationId: fresh.id,
            voiceEvent: "UNAUTHORIZED",
        });
    }
    if (state2.complete) {
        await emitVoiceAlert("VERIFY_OK");
    }
    return {
        ok: true,
        invitation: serializeInvitation(fresh),
        policy,
        requiredApprovals: requiredApprovalTypes(policy),
        pendingApprovals: state2.pending,
        entryAllowed: state2.complete && visitStatus === "APPROVED",
        watchlisted,
    };
}
async function failVerification(input, inv, reason, now, extra) {
    const message = REASON_MESSAGES[reason];
    let alertId;
    const alertType = REASON_ALERT_TYPE[reason];
    if (alertType) {
        const alert = await createAlert({
            type: alertType,
            priority: REASON_PRIORITY[reason] ?? "HIGH",
            title: reason === "ALREADY_INSIDE"
                ? "Visitor already inside premises"
                : "Unauthorized visitor attempt at gate",
            description: `${message}${extra ? ` ${extra}` : ""} Code presented at ${now.toISOString()}.`,
            gateId: input.gateId ?? null,
            subjectName: inv?.visitorName ?? null,
            subjectPhone: inv?.visitorPhone ?? null,
            invitationId: inv?.id ?? null,
            autoIncident: reason === "BLOCKED" || reason === "REJECTED",
        });
        alertId = alert.id;
        if (reason !== "ALREADY_INSIDE") {
            await emitVoiceAlert(reason === "BLOCKED" ? "UNAUTHORIZED" : "VERIFY_FAILED");
        }
    }
    else if (reason === "LOCKDOWN_ACTIVE") {
        await emitVoiceAlert("LOCKDOWN");
    }
    return { ok: false, reason, message, alertId };
}
export async function recordEntry(input) {
    if (await isLockdownActive()) {
        throw forbidden("Emergency lockdown is active — entry suspended", "LOCKDOWN_ACTIVE");
    }
    const inv = await prisma.visitorInvitation.findFirst({
        where: { id: input.invitationId, deletedAt: null },
        include: INVITATION_INCLUDE,
    });
    if (!inv)
        throw notFound("Invitation not found", "INVITATION_NOT_FOUND");
    if (inv.status === "CANCELLED" || inv.status === "EXPIRED") {
        throw conflict(`Invitation is ${inv.status.toLowerCase()}`, "INVITATION_INVALID");
    }
    if (inv.visitStatus === "INSIDE")
        throw conflict("Visitor is already inside", "ALREADY_INSIDE");
    if (inv.usedCount >= inv.maxUses)
        throw conflict("Entry usage limit reached", "EXHAUSTED");
    const now = new Date();
    if (now.getTime() > inv.arriveUntil.getTime() + 15 * 60_000) {
        throw conflict("Arrival window has passed", "OUTSIDE_WINDOW");
    }
    if (now.getTime() < inv.arriveFrom.getTime() - 30 * 60_000) {
        throw conflict("Entry is not permitted before the visiting window", "TOO_EARLY");
    }
    if (inv.resident.status !== "ACTIVE" || inv.resident.user.status !== "ACTIVE") {
        throw conflict("Hosting resident is inactive", "RESIDENT_INACTIVE");
    }
    if (inv.apartment.status !== "ACTIVE") {
        throw conflict("Hosting apartment is inactive", "APARTMENT_INACTIVE");
    }
    if (input.gateId && inv.allowedGateIds) {
        const allowed = inv.allowedGateIds.split(",").map((g) => g.trim()).filter(Boolean);
        if (allowed.length > 0 && !allowed.includes(input.gateId)) {
            throw conflict("This visitor is not permitted through this gate", "GATE_NOT_ALLOWED");
        }
    }
    const policy = inv.approvalPolicy ?? (await getApprovalPolicy());
    const state = computeApprovalState(inv, policy);
    if (state.rejected)
        throw conflict("Entry was rejected", "REJECTED");
    if (!state.complete) {
        throw conflict(`Pending approvals: ${state.pending.join(", ")}`, "APPROVAL_REQUIRED", {
            pending: state.pending,
        });
    }
    const reentry = inv.visitStatus === "EXITED";
    const entry = await prisma.visitorEntry.create({
        data: {
            invitationId: inv.id,
            gateId: input.gateId,
            guardId: input.guardUserId,
            photoPath: input.photoPath ?? null,
            vehicleNumber: input.vehicleNumber ?? inv.vehicleNumber,
            deviceInfo: input.deviceInfo ?? null,
            source: input.source ?? "CODE",
            enteredAt: now,
        },
    });
    const updated = await prisma.visitorInvitation.update({
        where: { id: inv.id },
        data: {
            visitStatus: "INSIDE",
            entryGateId: input.gateId,
            usedCount: { increment: 1 },
            status: inv.usedCount + 1 >= inv.maxUses ? "EXHAUSTED" : inv.status,
            overstayAlertedAt: null,
        },
        include: INVITATION_INCLUDE,
    });
    const gate = await prisma.gate.findUnique({ where: { id: input.gateId } });
    const gateName = gate?.name ?? "Gate";
    const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    await notify({
        userId: inv.resident.userId,
        type: "VISITOR_ENTRY",
        title: "Visitor entered the premises",
        body: `Your visitor ${inv.visitorName} has entered the premises through ${gateName} at ${timeStr}.${reentry ? " (re-entry)" : ""}`,
        priority: "MEDIUM",
        data: { invitationId: inv.id, gateId: input.gateId, entryId: entry.id },
    });
    hub.publish("staff", {
        type: "visitor-entry",
        data: {
            invitationId: inv.id,
            visitorName: inv.visitorName,
            flatNumber: inv.resident.apartment.flatNumber,
            gateName,
            enteredAt: entry.enteredAt,
        },
    });
    hub.toUser(inv.resident.userId, { type: "visitor-entry", data: { invitationId: inv.id } });
    return { entry, invitation: serializeInvitation(updated) };
}
export async function recordExit(input) {
    const inv = await prisma.visitorInvitation.findFirst({
        where: { id: input.invitationId, deletedAt: null },
        include: { ...INVITATION_INCLUDE, entries: { orderBy: { enteredAt: "desc" } } },
    });
    if (!inv)
        throw notFound("Invitation not found", "INVITATION_NOT_FOUND");
    if (inv.visitStatus !== "INSIDE") {
        throw conflict("Visitor is not currently inside the premises", "NOT_INSIDE");
    }
    const now = new Date();
    const lastEntry = inv.entries[0];
    const duration = lastEntry
        ? Math.max(1, Math.round((now.getTime() - lastEntry.enteredAt.getTime()) / 60_000))
        : null;
    const exit = await prisma.visitorExit.create({
        data: {
            invitationId: inv.id,
            gateId: input.gateId,
            guardId: input.guardUserId,
            deviceInfo: input.deviceInfo ?? null,
            durationMinutes: duration,
            exitedAt: now,
        },
    });
    const updated = await prisma.visitorInvitation.update({
        where: { id: inv.id },
        data: { visitStatus: "EXITED", exitGateId: input.gateId },
        include: INVITATION_INCLUDE,
    });
    const gate = await prisma.gate.findUnique({ where: { id: input.gateId } });
    const gateName = gate?.name ?? "Gate";
    const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    await notify({
        userId: inv.resident.userId,
        type: "VISITOR_EXIT",
        title: "Visitor exited the premises",
        body: `Your visitor ${inv.visitorName} has exited the premises through ${gateName} at ${timeStr}.${duration ? ` Total visit: ${duration} min.` : ""}`,
        priority: "LOW",
        data: { invitationId: inv.id, gateId: input.gateId, exitId: exit.id, duration },
    });
    hub.publish("staff", {
        type: "visitor-exit",
        data: {
            invitationId: inv.id,
            visitorName: inv.visitorName,
            flatNumber: inv.resident.apartment.flatNumber,
            gateName,
            exitedAt: exit.exitedAt,
            durationMinutes: duration,
        },
    });
    hub.toUser(inv.resident.userId, { type: "visitor-exit", data: { invitationId: inv.id } });
    return { exit, invitation: serializeInvitation(updated) };
}
export async function decideApproval(auth, invitationId, type, decision, reason) {
    if (await isLockdownActive()) {
        throw forbidden("Emergency lockdown is active — approvals suspended", "LOCKDOWN_ACTIVE");
    }
    const inv = await getInvitationScoped(auth, invitationId);
    if (inv.status === "CANCELLED" || inv.status === "EXPIRED" || inv.status === "EXHAUSTED") {
        throw conflict(`Invitation is ${inv.status.toLowerCase()}`, "INVITATION_INVALID");
    }
    if (inv.visitStatus === "INSIDE" || inv.visitStatus === "EXITED") {
        throw conflict("Visitor has already been processed", "ALREADY_PROCESSED");
    }
    if (type === "RESIDENT") {
        const isHost = auth.user.role === "RESIDENT" &&
            (auth.user.residentIds.includes(inv.residentId) ||
                auth.user.apartmentIds.includes(inv.apartmentId) ||
                inv.createdById === auth.user.id);
        const isOverride = ["SUPER_ADMIN", "ADMIN", "SECURITY"].includes(auth.user.role);
        if (!isHost && !isOverride) {
            throw forbidden("Only the hosting resident can approve this visitor", "NOT_HOST_RESIDENT");
        }
    }
    else if (type === "SECURITY") {
        if (!auth.permissions.includes("approvals:security")) {
            throw forbidden("Security approval requires security privileges", "MISSING_PERMISSION");
        }
    }
    else {
        throw badRequest("Unknown approval type", "INVALID_APPROVAL_TYPE");
    }
    const existing = inv.approvals.find((a) => a.type === type);
    if (existing && existing.status !== "PENDING") {
        throw conflict(`This ${type.toLowerCase()} decision was already recorded`, "ALREADY_DECIDED");
    }
    await prisma.visitorApproval.upsert({
        where: { invitationId_type: { invitationId: inv.id, type } },
        create: {
            invitationId: inv.id,
            type,
            status: decision,
            decidedAt: new Date(),
            decidedById: auth.user.id,
            reason: reason ?? null,
        },
        update: {
            status: decision,
            decidedAt: new Date(),
            decidedById: auth.user.id,
            reason: reason ?? null,
        },
    });
    const fresh = await getInvitationScoped(auth, inv.id);
    const policy = fresh.approvalPolicy ?? (await getApprovalPolicy());
    const state = computeApprovalState(fresh, policy);
    let visitStatus = fresh.visitStatus;
    if (decision === "REJECTED") {
        visitStatus = "DENIED";
    }
    else if (state.complete) {
        visitStatus = "APPROVED";
    }
    else {
        visitStatus = "AWAITING_APPROVAL";
    }
    const updated = await prisma.visitorInvitation.update({
        where: { id: fresh.id },
        data: {
            visitStatus,
            decidedAt: new Date(),
            decidedById: auth.user.id,
            rejectReason: decision === "REJECTED" ? (reason ?? "Entry rejected") : fresh.rejectReason,
        },
        include: INVITATION_INCLUDE,
    });
    const message = decision === "REJECTED"
        ? `Entry for visitor ${fresh.visitorName} was rejected.${reason ? ` Reason: ${reason}` : ""}`
        : state.complete
            ? `Visitor ${fresh.visitorName} is approved for entry.`
            : `Visitor ${fresh.visitorName}: ${type} approved. Waiting for remaining approvals.`;
    await notify({
        userId: fresh.resident.userId,
        type: decision === "REJECTED" ? "VISITOR_REJECTED" : "VISITOR_APPROVED",
        title: decision === "REJECTED" ? "Visitor entry rejected" : "Visitor entry approved",
        body: message,
        priority: decision === "REJECTED" ? "HIGH" : "MEDIUM",
        data: { invitationId: fresh.id, complete: state.complete },
    });
    const decidedPayload = {
        invitationId: fresh.id,
        code: fresh.code,
        visitorName: fresh.visitorName,
        type,
        decision,
        complete: decision === "APPROVED" && state.complete,
        visitStatus,
    };
    hub.publish("guards", { type: "approval-decided", data: decidedPayload });
    hub.publish("security", { type: "approval-decided", data: decidedPayload });
    hub.toUser(fresh.resident.userId, {
        type: "approval-decided",
        data: { invitationId: fresh.id, decision, complete: state.complete },
    });
    return serializeInvitation(updated);
}
export async function getCurrentlyInside(auth, query) {
    const where = { visitStatus: "INSIDE", deletedAt: null };
    const scoped = auth.user.role === "RESIDENT"
        ? {
            ...where,
            OR: [{ createdById: auth.user.id }, { residentId: { in: auth.user.residentIds } }],
        }
        : where;
    const [total, rows, grace] = await Promise.all([
        prisma.visitorInvitation.count({ where: scoped }),
        prisma.visitorInvitation.findMany({
            where: scoped,
            include: INVITATION_INCLUDE,
            orderBy: { updatedAt: "desc" },
            skip: offsetOf(query.page, query.limit),
            take: query.limit,
        }),
        getIntSetting("overstayGraceMinutes"),
    ]);
    return pageResult(rows.map((r) => ({ ...serializeInvitation(r), overstayGraceMinutes: grace })), total, query.page, query.limit);
}
export async function getPendingApprovals(auth) {
    const approvals = await prisma.visitorApproval.findMany({
        where: { status: "PENDING" },
        select: { invitationId: true, type: true },
    });
    const ids = [...new Set(approvals.map((a) => a.invitationId))];
    if (ids.length === 0)
        return [];
    const rows = await prisma.visitorInvitation.findMany({
        where: {
            id: { in: ids },
            deletedAt: null,
            status: "ACTIVE",
            visitStatus: { in: ["EXPECTED", "AWAITING_APPROVAL"] },
        },
        include: INVITATION_INCLUDE,
        orderBy: { expectedAt: "asc" },
        take: 100,
    });
    const scoped = auth.user.role === "RESIDENT"
        ? rows.filter((r) => r.createdById === auth.user.id ||
            auth.user.residentIds.includes(r.residentId) ||
            auth.user.apartmentIds.includes(r.apartmentId))
        : rows;
    return scoped.map(serializeInvitation);
}
