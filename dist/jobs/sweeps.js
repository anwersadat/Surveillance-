import { prisma } from "../db.js";
import { getBoolSetting, getIntSetting } from "../lib/settings.js";
import { createAlert } from "../services/alert.service.js";
import { notify } from "../services/notification.service.js";
import { INVITATION_INCLUDE } from "../services/visitor.service.js";
export async function runOverstaySweep() {
    if (!(await getBoolSetting("overstayEnabled")))
        return 0;
    const grace = await getIntSetting("overstayGraceMinutes");
    const now = new Date();
    const cutoff = new Date(now.getTime() - grace * 60_000);
    const overdue = await prisma.visitorInvitation.findMany({
        where: { visitStatus: "INSIDE", overstayAlertedAt: null, expectedExitAt: { lt: cutoff } },
        include: INVITATION_INCLUDE,
        take: 100,
    });
    for (const inv of overdue) {
        await prisma.visitorInvitation.update({
            where: { id: inv.id },
            data: { overstayAlertedAt: now },
        });
        const overdueBy = Math.round((now.getTime() - inv.expectedExitAt.getTime()) / 60000);
        await createAlert({
            type: "OVERSTAY",
            priority: "HIGH",
            title: "Visitor overstay detected",
            description: `Visitor ${inv.visitorName} (flat ${inv.resident.apartment.flatNumber}) has exceeded the expected visit duration by ${overdueBy} minutes.`,
            subjectName: inv.visitorName,
            subjectPhone: inv.visitorPhone,
            invitationId: inv.id,
            location: `Flat ${inv.resident.apartment.flatNumber}`,
            notifyAdmins: true,
        });
        await notify({
            userId: inv.resident.userId,
            type: "VISITOR_OVERSTAY",
            title: "Visitor overstay",
            body: `Your visitor ${inv.visitorName} has exceeded the expected visit duration by ${overdueBy} minutes.`,
            priority: "HIGH",
            data: { invitationId: inv.id },
        });
    }
    return overdue.length;
}
export async function runRetentionSweep() {
    if (!(await getBoolSetting("retentionAnonymizationEnabled")))
        return 0;
    const days = await getIntSetting("visitorDataRetentionDays");
    if (days <= 0)
        return 0;
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
    const stale = await prisma.visitorInvitation.findMany({
        where: { visitStatus: "EXITED", expectedAt: { lt: cutoff } },
        select: { id: true },
        take: 500,
    });
    for (const row of stale) {
        await prisma.visitorInvitation.update({
            where: { id: row.id },
            data: {
                visitorName: "Redacted",
                visitorPhone: null,
                vehicleNumber: null,
                notes: null,
                visitorPhotoPath: null,
            },
        });
    }
    return stale.length;
}
let overstayTimer = null;
let retentionTimer = null;
export function startBackgroundJobs() {
    if (overstayTimer || retentionTimer)
        return;
    overstayTimer = setInterval(() => {
        runOverstaySweep().catch((err) => console.error("[job:overstay]", err));
    }, 60_000);
    retentionTimer = setInterval(() => {
        runRetentionSweep().catch((err) => console.error("[job:retention]", err));
    }, 6 * 3600_000);
    overstayTimer.unref?.();
    retentionTimer.unref?.();
}
export function stopBackgroundJobs() {
    if (overstayTimer)
        clearInterval(overstayTimer);
    if (retentionTimer)
        clearInterval(retentionTimer);
    overstayTimer = null;
    retentionTimer = null;
}
