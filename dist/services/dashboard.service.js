import { prisma } from "../db.js";
import { getBoolSetting } from "../lib/settings.js";
import { INVITATION_INCLUDE, serializeInvitation } from "./visitor.service.js";
function startOfUtcDay(d) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
export async function computeSecurityStatus(lockdown) {
    if (lockdown)
        return "EMERGENCY";
    const critical = await prisma.securityAlert.count({
        where: { status: { in: ["NEW", "ACKNOWLEDGED"] }, priority: { in: ["CRITICAL", "EMERGENCY"] } },
    });
    if (critical > 0)
        return "ALERT";
    const high = await prisma.securityAlert.count({
        where: { status: { in: ["NEW", "ACKNOWLEDGED"] }, priority: "HIGH" },
    });
    const openIncidents = await prisma.securityIncident.count({
        where: { status: { in: ["NEW", "ACKNOWLEDGED", "INVESTIGATING"] } },
    });
    if (high > 0 || openIncidents > 0)
        return "ATTENTION";
    return "NORMAL";
}
export async function getSecurityDashboard() {
    const now = new Date();
    const today = startOfUtcDay(now);
    const lockdown = await getBoolSetting("lockdownActive");
    const [totalResidents, totalApartments, totalGuards, activeGates, visitorsToday, visitorsInside, pendingApprovals, approvedToday, exitedToday, activeAlerts, criticalAlerts, activeIncidents, unauthorizedToday,] = await Promise.all([
        prisma.resident.count({ where: { status: "ACTIVE", deletedAt: null } }),
        prisma.apartment.count({ where: { status: "ACTIVE", deletedAt: null } }),
        prisma.securityGuardProfile.count({ where: { status: "ACTIVE" } }),
        prisma.gate.count({ where: { status: "ACTIVE", deletedAt: null } }),
        prisma.visitorInvitation.count({ where: { createdAt: { gte: today } } }),
        prisma.visitorInvitation.count({ where: { visitStatus: "INSIDE" } }),
        prisma.visitorApproval.count({ where: { status: "PENDING" } }),
        prisma.visitorInvitation.count({
            where: { visitStatus: { in: ["APPROVED", "INSIDE", "EXITED"] }, updatedAt: { gte: today } },
        }),
        prisma.visitorInvitation.count({ where: { visitStatus: "EXITED", updatedAt: { gte: today } } }),
        prisma.securityAlert.count({ where: { status: { in: ["NEW", "ACKNOWLEDGED"] } } }),
        prisma.securityAlert.count({
            where: { status: { in: ["NEW", "ACKNOWLEDGED"] }, priority: { in: ["CRITICAL", "EMERGENCY"] } },
        }),
        prisma.securityIncident.count({ where: { status: { in: ["NEW", "ACKNOWLEDGED", "INVESTIGATING"] } } }),
        prisma.securityAlert.count({
            where: {
                createdAt: { gte: today },
                type: { in: ["INVALID_CODE", "EXPIRED_CODE", "UNAUTHORIZED_VISITOR", "WATCHLIST_MATCH"] },
            },
        }),
    ]);
    const [insideRows, recentAlerts, pendingRows, recentEntries] = await Promise.all([
        prisma.visitorInvitation.findMany({
            where: { visitStatus: "INSIDE" },
            include: INVITATION_INCLUDE,
            orderBy: { updatedAt: "desc" },
            take: 25,
        }),
        prisma.securityAlert.findMany({
            where: { status: { in: ["NEW", "ACKNOWLEDGED"] } },
            orderBy: { createdAt: "desc" },
            take: 10,
            include: { gate: { select: { name: true } } },
        }),
        prisma.visitorInvitation.findMany({
            where: { visitStatus: "AWAITING_APPROVAL", status: "ACTIVE" },
            include: INVITATION_INCLUDE,
            orderBy: { expectedAt: "asc" },
            take: 10,
        }),
        prisma.visitorEntry.findMany({
            where: { enteredAt: { gte: today } },
            orderBy: { enteredAt: "desc" },
            take: 15,
            include: {
                gate: { select: { name: true } },
                guard: { select: { name: true } },
                invitation: { select: { visitorName: true, code: true } },
            },
        }),
    ]);
    const status = await computeSecurityStatus(lockdown);
    return {
        securityStatus: status,
        lockdownActive: lockdown,
        metrics: {
            totalResidents,
            totalApartments,
            totalGuards,
            activeGates,
            visitorsToday,
            visitorsInside,
            pendingApprovals,
            approvedToday,
            exitedToday,
            activeAlerts,
            criticalAlerts,
            activeIncidents,
            unauthorizedAttempts: unauthorizedToday,
        },
        insideVisitors: insideRows.map((r) => {
            const s = serializeInvitation(r);
            const entry = r.entries[0];
            return {
                id: s.id,
                code: s.code,
                visitorName: s.visitorName,
                flatNumber: s.flatNumber,
                blockName: s.blockName,
                residentName: s.residentName,
                purpose: s.purpose,
                vehicleNumber: s.vehicleNumber,
                enteredAt: entry?.enteredAt ?? null,
                gateName: entry?.gate?.name ?? null,
                guardName: entry?.guard?.name ?? null,
                expectedExitAt: s.expectedExitAt,
            };
        }),
        recentAlerts: recentAlerts.map((a) => ({
            id: a.id,
            code: a.code,
            type: a.type,
            priority: a.priority,
            status: a.status,
            title: a.title,
            description: a.description,
            subjectName: a.subjectName,
            gateName: a.gate?.name ?? null,
            createdAt: a.createdAt,
        })),
        pendingApprovals: pendingRows.map(serializeInvitation),
        recentActivity: recentEntries.map((e) => ({
            id: e.id,
            visitorName: e.invitation.visitorName,
            code: e.invitation.code,
            gateName: e.gate.name,
            guardName: e.guard.name,
            enteredAt: e.enteredAt,
        })),
    };
}
export async function getResidentDashboard(auth) {
    const scope = {
        OR: [{ createdById: auth.user.id }, { residentId: { in: auth.user.residentIds } }],
    };
    const now = new Date();
    const today = startOfUtcDay(now);
    const [total, upcoming, inside, todayEntries, unread, pendingApprovals] = await Promise.all([
        prisma.visitorInvitation.count({ where: { ...scope, deletedAt: null } }),
        prisma.visitorInvitation.count({
            where: {
                ...scope,
                deletedAt: null,
                status: "ACTIVE",
                visitStatus: { in: ["EXPECTED", "AWAITING_APPROVAL", "APPROVED"] },
                arriveUntil: { gte: now },
            },
        }),
        prisma.visitorInvitation.findMany({
            where: { ...scope, visitStatus: "INSIDE" },
            include: INVITATION_INCLUDE,
            orderBy: { updatedAt: "desc" },
            take: 20,
        }),
        prisma.visitorInvitation.count({
            where: { ...scope, entries: { some: { enteredAt: { gte: today } } } },
        }),
        prisma.notification.count({ where: { userId: auth.user.id, readAt: null } }),
        prisma.visitorApproval.count({
            where: { status: "PENDING", invitation: scope },
        }),
    ]);
    const apartments = await prisma.apartment.findMany({
        where: { id: { in: auth.user.apartmentIds } },
        include: { block: { include: { building: true } }, floor: true },
    });
    return {
        metrics: {
            totalInvitations: total,
            upcoming,
            insideNow: inside.length,
            todayEntries,
            unreadNotifications: unread,
            pendingApprovals,
        },
        apartments: apartments.map((a) => ({
            id: a.id,
            flatNumber: a.flatNumber,
            blockName: a.block.name,
            buildingName: a.block.building.name,
            floor: a.floor.number,
            status: a.status,
        })),
        insideVisitors: inside.map(serializeInvitation),
    };
}
