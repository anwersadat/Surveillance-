const adapters = new Map();
export function registerCctvAdapter(adapter) {
    adapters.set(adapter.name.toUpperCase(), adapter);
}
export function getCctvAdapter(name) {
    return adapters.get(name.toUpperCase()) ?? null;
}
registerCctvAdapter({
    name: "GENERIC",
    async probe() {
        return { reachable: false, message: "Generic adapter does not probe streams; register a vendor adapter." };
    },
    async snapshot() {
        return null;
    },
});
