import fp from "fastify-plugin";
import websocket from "@fastify/websocket";
import { hub } from "../lib/wsHub.js";
import { prisma } from "../db.js";
export const websocketPlugin = fp(async (app) => {
    await app.register(websocket, {
        options: { maxPayload: 256 * 1024 },
    });
    app.get("/ws", { websocket: true }, (socket, req) => {
        const url = new URL(req.url, "http://localhost");
        const token = url.searchParams.get("token");
        if (!token) {
            socket.send(JSON.stringify({ type: "error", data: { message: "token required" } }));
            socket.close();
            return;
        }
        let payload;
        try {
            payload = app.jwt.verify(token);
        }
        catch {
            socket.send(JSON.stringify({ type: "error", data: { message: "invalid token" } }));
            socket.close();
            return;
        }
        void prisma.user
            .findFirst({ where: { id: payload.sub, status: "ACTIVE", deletedAt: null } })
            .then((user) => {
            if (!user) {
                socket.close();
                return;
            }
            hub.add(socket, user.id, user.role);
            socket.send(JSON.stringify({ type: "connected", data: { userId: user.id, role: user.role }, at: new Date().toISOString() }));
            socket.on("message", (raw) => {
                try {
                    const msg = JSON.parse(String(raw));
                    if (msg?.type === "ping") {
                        socket.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
                    }
                }
                catch {
                    // ignore malformed frames
                }
            });
            socket.on("close", () => hub.remove(socket));
            socket.on("error", () => hub.remove(socket));
        });
    });
});
