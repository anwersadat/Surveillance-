function consoleAdapter(name) {
    return {
        name,
        async send(msg) {
            if (process.env.NODE_ENV === "test")
                return;
            console.log(`[channel:${name}] priority=${msg.priority} to=${msg.to.name} | ${msg.title} — ${msg.body}`);
        },
    };
}
const registry = new Map([
    ["PUSH", consoleAdapter("PUSH")],
    ["EMAIL", consoleAdapter("EMAIL")],
    ["SMS", consoleAdapter("SMS")],
    ["WHATSAPP", consoleAdapter("WHATSAPP")],
]);
export function registerChannel(name, adapter) {
    registry.set(name.toUpperCase(), adapter);
}
export async function dispatchChannel(channel, msg) {
    const adapter = registry.get(channel.toUpperCase());
    if (!adapter)
        throw new Error(`No adapter registered for channel ${channel}`);
    await adapter.send(msg);
}
export function availableChannels() {
    return [...registry.keys()];
}
