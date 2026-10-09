import { prisma } from "../db.js";
import { INVITATION_INCLUDE, serializeInvitation } from "./visitor.service.js";
function rangeFilter(range, field = "expectedAt") {
    const where = {};
    if (range.from || range.to) {
        where[field] = {
            ...(range.from ? { gte: new Date(range.from) } : {}),
            ...(range.to ? { lte: new Date(range.to) } : {}),
        };
    }
    return where;
}
export async function reportDailyVisitors(range) {
    const rows = await prisma.visitorInvitation.findMany({
        where: { deletedAt: null, ...rangeFilter(range) },
        include: INVITATION_INCLUDE,
        orderBy: { expectedAt: "desc" },
        take: 5000,
    });
    return rows.map((r) => {
        const s = serializeInvitation(r);
        const entry = r.entries[0];
        const exit = r.exits[0];
        return {
            code: s.code,
            visitorName: s.visitorName,
            visitorPhone: s.visitorPhone,
            flatNumber: s.flatNumber,
            blockName: s.blockName,
            residentName: s.residentName,
            purpose: s.purpose,
            vehicleNumber: s.vehicleNumber,
            expectedAt: s.expectedAt,
            status: s.status,
            visitStatus: s.visitStatus,
            enteredAt: entry?.enteredAt ?? "",
            exitedAt: exit?.exitedAt ?? "",
            gate: entry?.gate?.name ?? "",
            guard: entry?.guard?.name ?? "",
        };
    });
}
export async function reportCurrentlyInside() {
    const rows = await prisma.visitorInvitation.findMany({
        where: { visitStatus: "INSIDE" },
        include: INVITATION_INCLUDE,
        orderBy: { updatedAt: "desc" },
    });
    return rows.map((r) => {
        const s = serializeInvitation(r);
        const entry = r.entries[0];
        return {
            code: s.code,
            visitorName: s.visitorName,
            flatNumber: s.flatNumber,
            residentName: s.residentName,
            enteredAt: entry?.enteredAt ?? "",
            gate: entry?.gate?.name ?? "",
            expectedExitAt: s.expectedExitAt,
            overstay: new Date() > s.expectedExitAt ? "YES" : "NO",
        };
    });
}
export async function reportUnauthorizedAttempts(range) {
    const rows = await prisma.securityAlert.findMany({
        where: {
            type: { in: ["INVALID_CODE", "EXPIRED_CODE", "UNAUTHORIZED_VISITOR", "WATCHLIST_MATCH", "UNKNOWN_PERSON"] },
            ...rangeFilter(range, "createdAt"),
        },
        include: { gate: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 5000,
    });
    return rows.map((a) => ({
        code: a.code,
        type: a.type,
        priority: a.priority,
        status: a.status,
        title: a.title,
        subjectName: a.subjectName,
        gate: a.gate?.name ?? "",
        createdAt: a.createdAt,
        resolvedAt: a.resolvedAt ?? "",
        resolution: a.resolution ?? "",
    }));
}
export async function reportIncidents(range) {
    const rows = await prisma.securityIncident.findMany({
        where: rangeFilter(range, "createdAt"),
        orderBy: { createdAt: "desc" },
        take: 5000,
    });
    return rows.map((i) => ({
        code: i.code,
        type: i.type,
        priority: i.priority,
        status: i.status,
        title: i.title,
        description: i.description,
        location: i.location ?? "",
        subjectName: i.subjectName ?? "",
        createdAt: i.createdAt,
        closedAt: i.closedAt ?? "",
        resolution: i.resolution ?? "",
    }));
}
export async function reportMissingExits() {
    const cutoff = new Date(Date.now() - 6 * 3600 * 1000);
    const rows = await prisma.visitorInvitation.findMany({
        where: { visitStatus: "INSIDE", expectedExitAt: { lt: cutoff } },
        include: INVITATION_INCLUDE,
        orderBy: { expectedExitAt: "asc" },
    });
    return rows.map((r) => {
        const s = serializeInvitation(r);
        const entry = r.entries[0];
        return {
            code: s.code,
            visitorName: s.visitorName,
            flatNumber: s.flatNumber,
            residentName: s.residentName,
            enteredAt: entry?.enteredAt ?? "",
            expectedExitAt: s.expectedExitAt,
            overdueMinutes: Math.round((Date.now() - s.expectedExitAt.getTime()) / 60000),
        };
    });
}
export async function reportVisitorsByApartment(range) {
    const rows = await prisma.visitorInvitation.groupBy({
        by: ["apartmentId"],
        _count: { _all: true },
        where: { deletedAt: null, ...rangeFilter(range) },
    });
    const apartments = await prisma.apartment.findMany({
        where: { id: { in: rows.map((r) => r.apartmentId) } },
        include: { block: { include: { building: true } } },
    });
    return rows.map((r) => {
        const apt = apartments.find((a) => a.id === r.apartmentId);
        return {
            flatNumber: apt?.flatNumber ?? "",
            block: apt?.block.name ?? "",
            building: apt?.block.building.name ?? "",
            totalVisitors: r._count._all,
        };
    });
}
export async function reportAlertsSummary(range) {
    const rows = await prisma.securityAlert.findMany({
        where: { ...rangeFilter(range, "createdAt") },
        select: { type: true, priority: true, status: true },
        take: 10000,
    });
    const summary = {};
    for (const r of rows) {
        const key = `${r.type}|${r.priority}|${r.status}`;
        summary[key] = (summary[key] ?? 0) + 1;
    }
    return Object.entries(summary).map(([key, count]) => {
        const [type, priority, status] = key.split("|");
        return { type, priority, status, count };
    });
}
export function scopeFor(auth) {
    if (auth.user.role === "RESIDENT") {
        return { OR: [{ createdById: auth.user.id }, { residentId: { in: auth.user.residentIds } }] };
    }
    return {};
}
