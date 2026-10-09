import { prisma } from "../db.js";
import { generateVisitorCode, qrPayloadForCode } from "../lib/codes.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { generateQRDataUrl } from "../lib/qr.js";
import { getApprovalPolicy, getBoolSetting, getIntSetting, getSetting } from "../lib/settings.js";
import { hub } from "../lib/wsHub.js";
import { offsetOf, pageResult } from "../lib/pagination.js";
export const INVITATION_INCLUDE = {
    resident: {
        include: {
            user: { select: { id: true, name: true, email: true, phone: true, status: true } },
            apartment: {
                include: {
                    block: { include: { building: { select: { id: true, name: true, code: true } } } },
                    floor: { select: { id: true, number: true } },
                },
            },
        },
    },
    apartment: {
        include: {
            block: { include: { building: { select: { id: true, name: true, code: true } } } },
            floor: { select: { id: true, number: true } },
        },
    },
    approvals: { include: { decidedBy: { select: { id: true, name: true } } } },
    entries: {
        orderBy: { enteredAt: "desc" },
        take: 3,
        include: {
            gate: { select: { id: true, name: true, code: true } },
            guard: { select: { id: true, name: true } },
        },
    },
    exits: {
        orderBy: { exitedAt: "desc" },
        take: 3,
        include: {
            gate: { select: { id: true, name: true, code: true } },
            guard: { select: { id: true, name: true } },
        },
    },
    residentUser: { select: { id: true, name: true, email: true } },
};
export function serializeInvitation(inv) {
    const apt = inv.resident.apartment;
    const block = apt.block;
    const lastEntry = inv.entries[0];
    const lastExit = inv.exits[0];
    return {
        id: inv.id,
        code: inv.code,
        qrPayload: qrPayloadForCode(inv.code),
        visitorName: inv.visitorName,
        visitorPhone: inv.visitorPhone,
        visitorPhotoPath: inv.visitorPhotoPath,
        purpose: inv.purpose,
        vehicleNumber: inv.vehicleNumber,
        notes: inv.notes,
        residentId: inv.residentId,
        residentName: inv.resident.user.name,
        residentUserId: inv.resident.userId,
        createdBy: inv.residentUser,
        apartmentId: inv.apartmentId,
        flatNumber: apt.flatNumber,
        blockName: block.name,
        buildingName: block.building.name,
        expectedAt: inv.expectedAt,
        arriveFrom: inv.arriveFrom,
        arriveUntil: inv.arriveUntil,
        expectedExitAt: inv.expectedExitAt,
        durationMinutes: inv.durationMinutes,
        expiresAt: inv.expiresAt,
        maxUses: inv.maxUses,
        usedCount: inv.usedCount,
        status: inv.status,
        visitStatus: inv.visitStatus,
        approvalPolicy: inv.approvalPolicy,
        allowedGateIds: inv.allowedGateIds,
        entryGateId: inv.entryGateId,
        exitGateId: inv.exitGateId,
        decidedAt: inv.decidedAt,
        rejectReason: inv.rejectReason,
        approvals: inv.approvals.map((a) => ({
            id: a.id,
            type: a.type,
            status: a.status,
            requestedAt: a.requestedAt,
            decidedAt: a.decidedAt,
            decidedByName: a.decidedBy?.name ?? null,
            reason: a.reason,
        })),
        lastEntry: lastEntry ?? null,
        lastExit: lastExit ?? null,
        createdAt: inv.createdAt,
        updatedAt: inv.updatedAt,
    };
}
function parseDate(value, field) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime()))
        throw badRequest(`Invalid date for ${field}`, "INVALID_DATE");
    return d;
}
export async function createInvitation(auth, input, audit) {
    const now = new Date();
    const expectedAt = parseDate(input.expectedAt, "expectedAt");
    const durationMinutes = input.durationMinutes ?? (await getIntSetting("invitationDefaultDurationMinutes"));
    const arrivalWindow = input.arrivalWindowMinutes ?? (await getIntSetting("invitationArrivalWindowMinutes"));
    const early = input.earlyArrivalMinutes ?? 30;
    if (!input.visitorName || input.visitorName.trim().length < 2) {
        throw badRequest("Visitor name is required", "VISITOR_NAME_REQUIRED");
    }
    if (expectedAt.getTime() < now.getTime() - 24 * 3600 * 1000) {
        throw badRequest("Expected arrival time cannot be in the past", "PAST_DATE");
    }
    const maxAhead = await getIntSetting("maxInvitationDaysAhead");
    if (expectedAt.getTime() > now.getTime() + maxAhead * 24 * 3600 * 1000) {
        throw badRequest(`Invitations can only be created up to ${maxAhead} days ahead`, "TOO_FAR_AHEAD");
    }
    if (durationMinutes < 5 || durationMinutes > 24 * 60) {
        throw badRequest("Duration must be between 5 minutes and 24 hours", "INVALID_DURATION");
    }
    if ((await getBoolSetting("requireVehicleNumber")) && !input.vehicleNumber) {
        throw badRequest("Vehicle number is required by policy", "VEHICLE_REQUIRED");
    }
    let residentId;
    let apartmentId;
    if (auth.user.role === "RESIDENT") {
        if (auth.user.residentIds.length === 0) {
            throw forbidden("No apartment is linked to this resident account", "NO_APARTMENT");
        }
        if (input.apartmentId && !auth.user.apartmentIds.includes(input.apartmentId)) {
            throw forbidden("You cannot create invitations for another apartment", "FOREIGN_APARTMENT");
        }
        apartmentId = input.apartmentId ?? auth.user.apartmentIds[0];
        const resident = await prisma.resident.findFirst({
            where: {
                userId: auth.user.id,
                apartmentId,
                status: "ACTIVE",
                deletedAt: null,
            },
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        });
        if (!resident)
            throw forbidden("Resident record not found for this apartment", "NO_RESIDENT");
        residentId = resident.id;
    }
    else {
        if (!input.apartmentId)
            throw badRequest("apartmentId is required", "APARTMENT_REQUIRED");
        const apartment = await prisma.apartment.findFirst({
            where: { id: input.apartmentId, status: "ACTIVE", deletedAt: null },
            include: { residents: { where: { status: "ACTIVE", deletedAt: null }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] } },
        });
        if (!apartment)
            throw notFound("Apartment not found", "APARTMENT_NOT_FOUND");
        if (apartment.residents.length === 0) {
            throw conflict("Apartment has no active resident to host this visitor", "NO_RESIDENT");
        }
        apartmentId = apartment.id;
        residentId = apartment.residents[0].id;
    }
    const policy = input.approvalPolicy ?? (await getApprovalPolicy());
    if (!["AUTO", "RESIDENT", "SECURITY", "BOTH"].includes(policy)) {
        throw badRequest("Invalid approval policy", "INVALID_POLICY");
    }
    const arriveFrom = new Date(expectedAt.getTime() - early * 60_000);
    const arriveUntil = new Date(expectedAt.getTime() + arrivalWindow * 60_000);
    const expectedExitAt = new Date(expectedAt.getTime() + durationMinutes * 60_000);
    if (arriveUntil.getTime() < now.getTime()) {
        throw badRequest("Arrival window has already passed", "WINDOW_PAST");
    }
    const allowedGateIds = input.allowedGateIds && input.allowedGateIds.length > 0 ? input.allowedGateIds.join(",") : null;
    let created = null;
    let attempts = 0;
    while (!created && attempts < 12) {
        attempts++;
        const code = generateVisitorCode(now);
        try {
            created = await prisma.visitorInvitation.create({
                data: {
                    code,
                    visitorName: input.visitorName.trim(),
                    visitorPhone: input.visitorPhone?.trim() || null,
                    visitorPhotoPath: input.visitorPhotoPath ?? null,
                    purpose: input.purpose?.trim() || null,
                    vehicleNumber: input.vehicleNumber?.trim().toUpperCase() || null,
                    notes: input.notes?.trim() || null,
                    residentId,
                    apartmentId,
                    createdById: auth.user.id,
                    expectedAt,
                    arriveFrom,
                    arriveUntil,
                    expectedExitAt,
                    durationMinutes,
                    expiresAt: arriveUntil,
                    maxUses: input.maxUses && input.maxUses > 0 ? input.maxUses : 1,
                    approvalPolicy: policy,
                    allowedGateIds,
                },
                include: INVITATION_INCLUDE,
            });
        }
        catch (err) {
            if (err.code === "P2002" && attempts < 12)
                continue;
            throw err;
        }
    }
    if (!created)
        throw conflict("Could not allocate a unique visitor code", "CODE_ALLOCATION_FAILED");
    await audit({
        action: "INVITATION_CREATED",
        entity: "VisitorInvitation",
        entityId: created.id,
        metadata: { code: created.code, apartmentId, policy },
    });
    hub.publish("broadcast", {
        type: "invitation-created",
        data: { id: created.id, flatNumber: serializeInvitation(created).flatNumber },
    });
    const qrDataUrl = await generateQRDataUrl(created.code);
    return { invitation: created, qrDataUrl };
}
export function scopeInvitationFilter(auth) {
    if (auth.user.role === "RESIDENT") {
        return {
            OR: [{ createdById: auth.user.id }, { residentId: { in: auth.user.residentIds } }],
        };
    }
    return {};
}
export async function listInvitations(auth, query) {
    const where = {
        deletedAt: null,
        ...scopeInvitationFilter(auth),
    };
    if (query.status)
        where.status = query.status;
    if (query.visitStatus)
        where.visitStatus = query.visitStatus;
    if (query.apartmentId)
        where.apartmentId = query.apartmentId;
    if (query.from || query.to) {
        where.expectedAt = {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
        };
    }
    if (query.q) {
        const q = query.q;
        where.OR = [
            { visitorName: { contains: q } },
            { visitorPhone: { contains: q } },
            { code: { contains: q.toUpperCase() } },
            { vehicleNumber: { contains: q.toUpperCase() } },
            { resident: { user: { name: { contains: q } } } },
            { apartment: { flatNumber: { contains: q } } },
        ];
    }
    const [total, rows] = await Promise.all([
        prisma.visitorInvitation.count({ where }),
        prisma.visitorInvitation.findMany({
            where,
            include: INVITATION_INCLUDE,
            orderBy: { expectedAt: "desc" },
            skip: offsetOf(query.page, query.limit),
            take: query.limit,
        }),
    ]);
    return pageResult(rows.map(serializeInvitation), total, query.page, query.limit);
}
export async function getInvitationScoped(auth, id) {
    const inv = await prisma.visitorInvitation.findFirst({
        where: { id, deletedAt: null },
        include: INVITATION_INCLUDE,
    });
    if (!inv)
        throw notFound("Invitation not found", "INVITATION_NOT_FOUND");
    if (auth.user.role === "RESIDENT") {
        const owned = inv.createdById === auth.user.id ||
            auth.user.residentIds.includes(inv.residentId) ||
            auth.user.apartmentIds.includes(inv.apartmentId);
        if (!owned)
            throw forbidden("Access denied to this invitation", "FOREIGN_INVITATION");
    }
    return inv;
}
export async function cancelInvitation(auth, id, reason, audit) {
    const inv = await getInvitationScoped(auth, id);
    if (["EXITED", "CANCELLED"].includes(inv.status)) {
        throw conflict(`Invitation is already ${inv.status}`, "NOT_CANCELABLE");
    }
    if (inv.visitStatus === "INSIDE") {
        throw conflict("Visitor is currently inside the premises; record an exit first", "VISITOR_INSIDE");
    }
    const updated = await prisma.visitorInvitation.update({
        where: { id: inv.id },
        data: {
            status: "CANCELLED",
            visitStatus: inv.visitStatus === "AWAITING_APPROVAL" ? "DENIED" : inv.visitStatus,
            rejectReason: reason ?? "Cancelled by user",
            approvals: { updateMany: { where: { status: "PENDING" }, data: { status: "REJECTED", decidedAt: new Date(), reason: reason ?? "Cancelled" } } },
        },
        include: INVITATION_INCLUDE,
    });
    await audit({
        action: "INVITATION_CANCELLED",
        entity: "VisitorInvitation",
        entityId: inv.id,
        metadata: { code: inv.code, reason },
    });
    hub.publish("broadcast", { type: "invitation-cancelled", data: { id: inv.id } });
    const { notify } = await import("./notification.service.js");
    await notify({
        userId: inv.resident.userId,
        type: "VISITOR_CANCELLED",
        title: "Visitor invitation cancelled",
        body: `The invitation for ${inv.visitorName} (${inv.code}) has been cancelled.`,
        priority: "MEDIUM",
        data: { invitationId: inv.id },
    });
    return updated;
}
export async function extendInvitation(auth, id, minutes, audit) {
    if (!(await getBoolSetting("allowInvitationExtension"))) {
        throw forbidden("Invitation extension is disabled by administrator", "EXTENSION_DISABLED");
    }
    const inv = await getInvitationScoped(auth, id);
    if (inv.status !== "ACTIVE")
        throw conflict("Only active invitations can be extended", "NOT_ACTIVE");
    if (inv.visitStatus === "INSIDE")
        throw conflict("Visitor is already inside", "VISITOR_INSIDE");
    if (minutes < 5 || minutes > 24 * 60)
        throw badRequest("Invalid extension window", "INVALID_EXTENSION");
    const arriveUntil = new Date(Math.max(inv.arriveUntil.getTime(), Date.now()) + minutes * 60_000);
    const updated = await prisma.visitorInvitation.update({
        where: { id: inv.id },
        data: { arriveUntil, expiresAt: arriveUntil, status: "ACTIVE" },
        include: INVITATION_INCLUDE,
    });
    await audit({
        action: "INVITATION_EXTENDED",
        entity: "VisitorInvitation",
        entityId: inv.id,
        metadata: { minutes, arriveUntil: arriveUntil.toISOString() },
    });
    return updated;
}
export async function findInvitationByCode(code) {
    return prisma.visitorInvitation.findUnique({
        where: { code },
        include: INVITATION_INCLUDE,
    });
}
export async function getDefaultApprovalPolicy() {
    return getApprovalPolicy();
}
export async function listGates() {
    return prisma.gate.findMany({ where: { status: "ACTIVE", deletedAt: null }, orderBy: { name: "asc" } });
}
export { getSetting };
