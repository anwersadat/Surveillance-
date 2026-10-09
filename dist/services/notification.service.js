import { prisma } from "../db.js";
import { hub } from "../lib/wsHub.js";
import { getSetting } from "../lib/settings.js";
import { dispatchChannel } from "../integrations/channels.js";
async function resolveChannels(explicit) {
    if (explicit && explicit.length > 0)
        return explicit;
    const raw = await getSetting("notifyChannels");
    return raw
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
}
export async function notify(input) {
    try {
        const user = await prisma.user.findFirst({
            where: { id: input.userId, status: "ACTIVE", deletedAt: null },
            select: { id: true, name: true, email: true, phone: true },
        });
        if (!user)
            return;
        const notification = await prisma.notification.create({
            data: {
                userId: user.id,
                type: input.type,
                title: input.title,
                body: input.body,
                priority: input.priority ?? "LOW",
                data: input.data ? JSON.stringify(input.data) : null,
            },
        });
        const channels = await resolveChannels(input.channels);
        const outbound = {
            title: input.title,
            body: input.body,
            to: { name: user.name, email: user.email, phone: user.phone },
            priority: input.priority ?? "LOW",
        };
        for (const channel of channels) {
            const delivery = await prisma.notificationDelivery.create({
                data: { notificationId: notification.id, channel, status: "QUEUED" },
            });
            try {
                if (channel === "IN_APP") {
                    await prisma.notificationDelivery.update({
                        where: { id: delivery.id },
                        data: { status: "SENT", attempts: 1 },
                    });
                }
                else {
                    await dispatchChannel(channel, outbound);
                    await prisma.notificationDelivery.update({
                        where: { id: delivery.id },
                        data: { status: "SENT", attempts: 1 },
                    });
                }
            }
            catch (err) {
                await prisma.notificationDelivery.update({
                    where: { id: delivery.id },
                    data: {
                        status: "FAILED",
                        attempts: 1,
                        lastError: err instanceof Error ? err.message : String(err),
                    },
                });
            }
        }
        hub.toUser(user.id, {
            type: "notification",
            data: {
                id: notification.id,
                notificationType: notification.type,
                title: notification.title,
                body: notification.body,
                priority: notification.priority,
                data: notification.data ? JSON.parse(notification.data) : null,
                createdAt: notification.createdAt,
            },
        });
    }
    catch (err) {
        console.error("[notifications] failed to deliver notification", err);
    }
}
export async function notifyRoles(roles, input) {
    const users = await prisma.user.findMany({
        where: { role: { in: roles }, status: "ACTIVE", deletedAt: null },
        select: { id: true },
    });
    await Promise.all(users.map((u) => notify({ ...input, userId: u.id })));
}
export async function notifyUsers(userIds, input) {
    await Promise.all(userIds.map((id) => notify({ ...input, userId: id })));
}
export const NOTIFICATION_INCLUDE = {
    deliveries: true,
};
