import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";
export function encryptSecret(plain) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", config.encryptionKey, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}
export function decryptSecret(payload) {
    const [ivB, tagB, dataB] = payload.split(".");
    if (!ivB || !tagB || !dataB)
        throw new Error("Invalid encrypted payload");
    const decipher = createDecipheriv("aes-256-gcm", config.encryptionKey, Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB, "base64")), decipher.final()]).toString("utf8");
}
