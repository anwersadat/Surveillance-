import { randomInt, randomBytes, createHash, timingSafeEqual } from "node:crypto";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const SHORT_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
export function randomCode(length, alphabet = CODE_ALPHABET) {
    let out = "";
    for (let i = 0; i < length; i++) {
        out += alphabet[randomInt(0, alphabet.length)];
    }
    return out;
}
export function generateVisitorCode(date = new Date()) {
    return `VIS-${date.getUTCFullYear()}-${randomCode(6)}`;
}
export function generateAlertCode(date = new Date()) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `ALT-${y}${m}${d}-${randomCode(5, SHORT_ALPHABET)}`;
}
export function generateIncidentCode(date = new Date()) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `INC-${y}${m}${d}-${randomCode(5, SHORT_ALPHABET)}`;
}
export function normalizeVisitorCode(input) {
    let code = input.trim().toUpperCase();
    if (code.startsWith("SVC:"))
        code = code.slice(4);
    if (code.startsWith("SVC1:"))
        code = code.slice(5);
    return code;
}
export const QR_PREFIX = "SVC:";
export function qrPayloadForCode(code) {
    return `${QR_PREFIX}${code}`;
}
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function safeEquals(a, b) {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length)
        return false;
    return timingSafeEqual(ba, bb);
}
export function randomToken(bytes = 32) {
    return randomBytes(bytes).toString("base64url");
}
