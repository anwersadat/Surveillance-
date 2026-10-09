export function authOf(req) {
    if (!req.auth) {
        throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
    }
    return req.auth;
}
