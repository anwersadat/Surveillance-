import { prisma } from "../db.js";
export async function writeAudit(userId, userRole, entry, req) {
    try {
        await prisma.auditLog.create({
            data: {
                userId: userId ?? null,
                userRole: userRole ?? null,
                action: entry.action,
                entity: entry.entity ?? null,
                entityId: entry.entityId ?? null,
                result: entry.result ?? "SUCCESS",
                ip: req?.ip ?? null,
                device: req?.headers["user-agent"] ?? null,
                metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
            },
        });
    }
    catch (err) {
        console.error("[audit] failed to write audit log", err);
    }
}
export function auditFromRequest(req) {
    return (entry) => writeAudit(req.auth?.user.id, req.auth?.user.role, entry, req);
}
