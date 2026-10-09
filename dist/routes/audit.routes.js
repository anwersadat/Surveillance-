import { z } from "zod";
import { prisma } from "../db.js";
import { paginationQuery, offsetOf, pageResult } from "../lib/pagination.js";
import { auditFromRequest } from "../lib/audit.js";
export async function auditRoutes(app) {
    app.get("/api/audit", {
        ...app.requirePermission("audit:read"),
        schema: {
            tags: ["Admin"],
            summary: "Search audit logs (action, user, entity, result, date range)",
        },
    }, async (req, reply) => {
        const q = paginationQuery
            .extend({
            action: z.string().optional(),
            userId: z.string().optional(),
            entity: z.string().optional(),
            result: z.enum(["SUCCESS", "FAILURE"]).optional(),
            from: z.string().optional(),
            to: z.string().optional(),
        })
            .parse(req.query);
        const where = {
            ...(q.action ? { action: { contains: q.action } } : {}),
            ...(q.userId ? { userId: q.userId } : {}),
            ...(q.entity ? { entity: q.entity } : {}),
            ...(q.result ? { result: q.result } : {}),
            ...(q.from || q.to
                ? {
                    createdAt: {
                        ...(q.from ? { gte: new Date(q.from) } : {}),
                        ...(q.to ? { lte: new Date(q.to) } : {}),
                    },
                }
                : {}),
            ...(q.q ? { OR: [{ action: { contains: q.q } }, { entity: { contains: q.q } }, { user: { name: { contains: q.q } } }] } : {}),
        };
        const [total, rows] = await Promise.all([
            prisma.auditLog.count({ where }),
            prisma.auditLog.findMany({
                where,
                include: { user: { select: { id: true, name: true, email: true } } },
                orderBy: { createdAt: "desc" },
                skip: offsetOf(q.page, q.limit),
                take: q.limit,
            }),
        ]);
        return reply.send(pageResult(rows, total, q.page, q.limit));
    });
    app.get("/api/audit/actions", { ...app.requirePermission("audit:read"), schema: { tags: ["Admin"], summary: "Distinct audit actions (for filters)" } }, async (req, reply) => {
        const rows = await prisma.auditLog.findMany({ select: { action: true }, distinct: ["action"], orderBy: { action: "asc" } });
        return reply.send({ items: rows.map((r) => r.action) });
    });
}
export async function reportRoutes(app) {
    const names = [
        "daily-visitors",
        "currently-inside",
        "unauthorized-attempts",
        "incidents",
        "missing-exits",
        "by-apartment",
        "alerts-summary",
    ];
    app.get("/api/reports/:name", {
        ...app.requirePermission("reports:read"),
        schema: {
            tags: ["Reports"],
            summary: "Generate a report",
            description: `Available reports: ${names.join(", ")}. Use ?format=csv for CSV download (opens in Excel), default JSON.`,
        },
    }, async (req, reply) => {
        const { name } = req.params;
        const q = z
            .object({
            format: z.enum(["json", "csv"]).default("json"),
            from: z.string().optional(),
            to: z.string().optional(),
        })
            .parse(req.query);
        if (!names.includes(name)) {
            return reply.status(404).send({ error: { code: "REPORT_NOT_FOUND", message: `Unknown report: ${name}` } });
        }
        const mod = await import("../services/report.service.js");
        const range = { from: q.from, to: q.to };
        let rows = [];
        switch (name) {
            case "daily-visitors":
                rows = await mod.reportDailyVisitors(range);
                break;
            case "currently-inside":
                rows = await mod.reportCurrentlyInside();
                break;
            case "unauthorized-attempts":
                rows = await mod.reportUnauthorizedAttempts(range);
                break;
            case "incidents":
                rows = await mod.reportIncidents(range);
                break;
            case "missing-exits":
                rows = await mod.reportMissingExits();
                break;
            case "by-apartment":
                rows = await mod.reportVisitorsByApartment(range);
                break;
            case "alerts-summary":
                rows = await mod.reportAlertsSummary(range);
                break;
        }
        await auditFromRequest(req)({ action: "REPORT_GENERATED", entity: "Report", entityId: name, metadata: { format: q.format, from: q.from, to: q.to } });
        if (q.format === "csv") {
            const { toCsv } = await import("../lib/csv.js");
            const csv = toCsv(rows);
            return reply
                .header("Content-Type", "text/csv; charset=utf-8")
                .header("Content-Disposition", `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`)
                .send(csv);
        }
        return reply.send({ report: name, generatedAt: new Date().toISOString(), total: rows.length, items: rows });
    });
    app.get("/api/reports", { ...app.requirePermission("reports:read"), schema: { tags: ["Reports"], summary: "Available reports" } }, async (req, reply) => reply.send({ items: names }));
}
