import { prisma } from "../db.js";
export const SETTING_DEFAULTS = {
    approvalPolicy: "RESIDENT", // AUTO | RESIDENT | SECURITY | BOTH
    lockdownActive: "false",
    overstayEnabled: "true",
    overstayGraceMinutes: "15",
    visitorDataRetentionDays: "90",
    retentionAnonymizationEnabled: "false",
    voiceAlertsEnabled: "true",
    allowInvitationExtension: "true",
    maxInvitationDaysAhead: "30",
    invitationDefaultDurationMinutes: "120",
    invitationArrivalWindowMinutes: "60",
    requireVehicleNumber: "false",
    notifyChannels: "IN_APP,PUSH",
    alertChannels: "IN_APP,PUSH",
    securityStatusNormalThreshold: "0",
    systemName: "SecureResident",
    integrationApiKey: "",
};
export async function getSetting(key) {
    const row = await prisma.systemSetting.findUnique({ where: { key } });
    if (row)
        return row.value;
    return SETTING_DEFAULTS[key] ?? "";
}
export async function getBoolSetting(key) {
    return (await getSetting(key)).toLowerCase() === "true";
}
export async function getIntSetting(key) {
    const v = Number(await getSetting(key));
    return Number.isFinite(v) ? v : Number(SETTING_DEFAULTS[key] ?? 0);
}
export async function getManySettings(keys) {
    const keysToFetch = keys ?? Object.keys(SETTING_DEFAULTS);
    const rows = await prisma.systemSetting.findMany({
        where: { key: { in: keysToFetch } },
    });
    const out = {};
    for (const k of keysToFetch) {
        const row = rows.find((r) => r.key === k);
        out[k] = row ? row.value : (SETTING_DEFAULTS[k] ?? "");
    }
    return out;
}
export async function setSetting(key, value, updatedBy) {
    await prisma.systemSetting.upsert({
        where: { key },
        create: { key, value, updatedBy },
        update: { value, updatedBy },
    });
}
export async function isLockdownActive() {
    return getBoolSetting("lockdownActive");
}
export async function getApprovalPolicy() {
    const policy = await getSetting("approvalPolicy");
    return ["AUTO", "RESIDENT", "SECURITY", "BOTH"].includes(policy) ? policy : "RESIDENT";
}
