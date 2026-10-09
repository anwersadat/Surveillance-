export function topicsForUser(userId, role) {
    const topics = ["broadcast", `user:${userId}`, `role:${role}`];
    if (["SUPER_ADMIN", "ADMIN", "SECURITY", "GUARD"].includes(role))
        topics.push("staff");
    if (["SUPER_ADMIN", "ADMIN", "SECURITY"].includes(role))
        topics.push("security");
    if (role === "GUARD")
        topics.push("guards");
    if (["SUPER_ADMIN", "ADMIN"].includes(role))
        topics.push("admins");
    if (role === "RESIDENT")
        topics.push("residents");
    return topics;
}
class WsHub {
    clients = new Map();
    add(socket, userId, role) {
        this.clients.set(socket, {
            socket,
            userId,
            role,
            topics: new Set(topicsForUser(userId, role)),
        });
    }
    remove(socket) {
        this.clients.delete(socket);
    }
    publish(topic, message) {
        const payload = JSON.stringify({ ...message, at: message.at ?? new Date().toISOString() });
        for (const client of this.clients.values()) {
            if (client.topics.has(topic)) {
                try {
                    if (client.socket.readyState === 1)
                        client.socket.send(payload);
                }
                catch {
                    this.clients.delete(client.socket);
                }
            }
        }
    }
    publishMany(topics, message) {
        for (const t of topics)
            this.publish(t, message);
    }
    toUser(userId, message) {
        this.publish(`user:${userId}`, message);
    }
    toRoles(roles, message) {
        for (const role of roles)
            this.publish(`role:${role}`, message);
    }
    broadcast(message) {
        this.publish("broadcast", message);
    }
    get size() {
        return this.clients.size;
    }
}
export const hub = new WsHub();
