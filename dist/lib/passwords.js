import bcrypt from "bcryptjs";
const ROUNDS = 12;
export async function hashPassword(plain) {
    return bcrypt.hash(plain, ROUNDS);
}
export async function verifyPassword(plain, hash) {
    return bcrypt.compare(plain, hash);
}
export function checkPasswordPolicy(password) {
    const errors = [];
    if (password.length < 10)
        errors.push("Must be at least 10 characters long");
    if (!/[A-Z]/.test(password))
        errors.push("Must contain an uppercase letter");
    if (!/[a-z]/.test(password))
        errors.push("Must contain a lowercase letter");
    if (!/[0-9]/.test(password))
        errors.push("Must contain a digit");
    if (!/[^A-Za-z0-9]/.test(password))
        errors.push("Must contain a symbol");
    const common = ["password123!", "qwerty12345!", "letmein123!"];
    if (common.includes(password.toLowerCase()))
        errors.push("Password is too common");
    return { ok: errors.length === 0, errors };
}
