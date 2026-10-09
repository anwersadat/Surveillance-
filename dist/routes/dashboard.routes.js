import { getSecurityDashboard, getResidentDashboard } from "../services/dashboard.service.js";
import { prisma } from "../db.js";
import { generateQRDataUrl } from "../lib/qr.js";
import { notFound } from "../lib/errors.js";
import { getBoolSetting } from "../lib/settings.js";
export async function dashboardRoutes(app) {
    app.get("/api/dashboard/security", { ...app.requirePermission("dashboard:security"), schema: { tags: ["Admin"], summary: "Real-time security dashboard metrics, live visitor list and alerts" } }, async (req, reply) => reply.send(await getSecurityDashboard()));
    app.get("/api/dashboard/resident", { preHandler: [app.authenticate], schema: { tags: ["Residents"], summary: "Resident dashboard metrics and active visitors" } }, async (req, reply) => reply.send(await getResidentDashboard(req.auth)));
}
export async function publicRoutes(app) {
    app.get("/api/public/health", { schema: { tags: ["Auth"], summary: "Service health probe" } }, async (req, reply) => reply.send({ status: "ok", time: new Date().toISOString() }));
    app.get("/api/public/invitations/:code", {
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
            tags: ["Invitations"],
            summary: "Public visitor portal — view your own invitation status",
            description: "Limited, non-sensitive view for the visitor (name, flat, purpose, timing, status). Resident contact details are never exposed.",
        },
    }, async (req, reply) => {
        const { code } = req.params;
        const inv = await prisma.visitorInvitation.findUnique({
            where: { code: code.trim().toUpperCase() },
            include: {
                resident: {
                    include: {
                        user: { select: { name: true } },
                        apartment: { include: { block: { include: { building: true } } } },
                    },
                },
                approvals: true,
            },
        });
        if (!inv || inv.deletedAt)
            throw notFound("Invitation not found", "INVITATION_NOT_FOUND");
        const residentName = inv.resident.user.name ?? "";
        const qrDataUrl = await generateQRDataUrl(inv.code);
        return reply.send({
            code: inv.code,
            visitorName: inv.visitorName,
            hostFirstName: residentName.split(" ")[0],
            flatNumber: inv.resident.apartment.flatNumber,
            block: inv.resident.apartment.block.name,
            building: inv.resident.apartment.block.building.name,
            purpose: inv.purpose,
            vehicleNumber: inv.vehicleNumber,
            expectedAt: inv.expectedAt,
            arriveFrom: inv.arriveFrom,
            arriveUntil: inv.arriveUntil,
            expectedExitAt: inv.expectedExitAt,
            expiresAt: inv.expiresAt,
            durationMinutes: inv.durationMinutes,
            status: inv.status,
            visitStatus: inv.visitStatus,
            approvalPolicy: inv.approvalPolicy,
            approvals: inv.approvals.map((a) => ({ type: a.type, status: a.status })),
            lockdownActive: await getBoolSetting("lockdownActive"),
            qrDataUrl,
            showQr: inv.status === "ACTIVE" && inv.visitStatus !== "EXITED" && inv.visitStatus !== "DENIED",
        });
    });
}
export async function uploadRoutes(app) {
    app.post("/api/uploads", {
        preHandler: [app.authenticate],
        schema: {
            tags: ["Auth"],
            summary: "Upload an image (visitor/incident photo, avatar)",
            description: "Multipart form upload. Files are stored with random names; only image types are accepted (max 5 MB).",
        },
    }, async (req, reply) => {
        const file = await req.file();
        if (!file) {
            return reply.status(400).send({ error: { code: "NO_FILE", message: "No file provided" } });
        }
        const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
        if (!allowed.includes(file.mimetype)) {
            return reply.status(400).send({ error: { code: "INVALID_TYPE", message: "Only JPEG, PNG, WEBP or GIF images are allowed" } });
        }
        const { randomBytes } = await import("node:crypto");
        const ext = file.mimetype === "image/jpeg" ? "jpg" : file.mimetype === "image/png" ? "png" : file.mimetype === "image/webp" ? "webp" : "gif";
        const name = `${Date.now()}-${randomBytes(12).toString("hex")}.${ext}`;
        const { writeFile, mkdir } = await import("node:fs/promises");
        const path = await import("node:path");
        const dir = path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? "uploads");
        await mkdir(dir, { recursive: true });
        const buf = await file.toBuffer();
        if (buf.length > 5 * 1024 * 1024) {
            return reply.status(400).send({ error: { code: "TOO_LARGE", message: "File exceeds 5 MB" } });
        }
        await writeFile(path.join(dir, name), buf);
        return reply.status(201).send({ path: `/uploads/${name}`, filename: name, size: buf.length });
    });
}
export async function miscRoutes(app) {
    app.get("/api/system/info", { preHandler: [app.authenticate], schema: { tags: ["Admin"], summary: "System information and role counters" } }, async (req, reply) => {
        const [users, residents, guards, gates, cameras] = await Promise.all([
            prisma.user.count({ where: { status: "ACTIVE", deletedAt: null } }),
            prisma.resident.count({ where: { status: "ACTIVE", deletedAt: null } }),
            prisma.securityGuardProfile.count({ where: { status: "ACTIVE" } }),
            prisma.gate.count({ where: { status: "ACTIVE", deletedAt: null } }),
            prisma.camera.count({ where: { deletedAt: null, status: "ONLINE" } }),
        ]);
        const last24h = new Date(Date.now() - 24 * 3600 * 1000);
        const [auditCount, alerts24h] = await Promise.all([
            prisma.auditLog.count({ where: { createdAt: { gte: last24h } } }),
            prisma.securityAlert.count({ where: { createdAt: { gte: last24h } } }),
        ]);
        return reply.send({ users, residents, guards, gates, camerasOnline: cameras, auditEvents24h: auditCount, alerts24h });
    });
}
