const adapters = new Map();
export function registerAccessControlAdapter(adapter) {
    adapters.set(adapter.protocol.toUpperCase(), adapter);
}
export function getAccessControlAdapter(protocol) {
    return adapters.get(protocol.toUpperCase()) ?? null;
}
registerAccessControlAdapter({
    protocol: "HTTP",
    async sendCommand(accessPointId, command, reason) {
        console.log(`[access-control:http] ap=${accessPointId} cmd=${command} reason=${reason ?? "-"}`);
        return {
            ok: false,
            accessPointId,
            command,
            message: "No HTTP gate controller is configured. Gate remains closed (fail secure).",
            at: new Date().toISOString(),
        };
    },
});
