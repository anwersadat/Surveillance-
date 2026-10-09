import { prisma } from "../db.js";
import { hub } from "../lib/wsHub.js";
import { getBoolSetting } from "../lib/settings.js";
export const VOICE_EVENTS = [
    "VERIFY_OK",
    "VERIFY_FAILED",
    "UNAUTHORIZED",
    "UNKNOWN_PERSON",
    "OVERSTAY",
    "LOCKDOWN",
    "EMERGENCY",
];
export const VOICE_EVENT_DEFAULTS = {
    VERIFY_OK: { message: "Visitor verified.", priority: "LOW" },
    VERIFY_FAILED: { message: "Warning. Visitor code could not be verified.", priority: "HIGH" },
    UNAUTHORIZED: {
        message: "Security alert. An unverified visitor is attempting to enter the premises.",
        priority: "CRITICAL",
    },
    UNKNOWN_PERSON: {
        message: "Security alert. An unidentified visitor has been detected inside the apartment premises. Security personnel are requested to verify immediately.",
        priority: "EMERGENCY",
    },
    OVERSTAY: { message: "Alert. A visitor has exceeded the expected visit duration.", priority: "MEDIUM" },
    LOCKDOWN: { message: "Emergency alert. Please follow security procedures immediately.", priority: "EMERGENCY" },
    EMERGENCY: { message: "Emergency alert. Please follow security procedures immediately.", priority: "EMERGENCY" },
};
export async function emitVoiceAlert(event) {
    try {
        if (!(await getBoolSetting("voiceAlertsEnabled")))
            return null;
        const cfg = await prisma.voiceAlertConfig.findUnique({ where: { event } });
        if (!cfg || !cfg.enabled)
            return null;
        const payload = {
            event,
            message: cfg.message,
            priority: cfg.priority,
            voice: cfg.voice,
            volume: cfg.volume,
            repeatCount: cfg.repeatCount,
            repeatIntervalSeconds: cfg.repeatIntervalSeconds,
            targetRoles: cfg.targetRoles
                .split(",")
                .map((r) => r.trim())
                .filter(Boolean),
        };
        for (const role of payload.targetRoles) {
            hub.publish(`role:${role}`, { type: "voice-alert", data: payload });
        }
        hub.publish("staff", { type: "voice-alert", data: payload });
        return payload;
    }
    catch (err) {
        console.error("[voice] failed to emit voice alert", err);
        return null;
    }
}
