import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
export const swaggerPlugin = fp(async (app) => {
    await app.register(swagger, {
        openapi: {
            openapi: "3.0.3",
            info: {
                title: "Residential Apartment Security, Visitor Management & Surveillance API",
                description: "Security-first REST API for resident visitor invitations, guard verification, approvals, entry/exit tracking, real-time alerts, incidents, lockdown and device integrations.",
                version: "1.0.0",
            },
            servers: [{ url: "/", description: "Current host" }],
            components: {
                securitySchemes: {
                    bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
                    apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
                },
            },
            tags: [
                { name: "Auth", description: "Authentication and session management" },
                { name: "Residents", description: "Residents, apartments and buildings" },
                { name: "Invitations", description: "Visitor invitation lifecycle" },
                { name: "Verification", description: "Guard verification, approvals, entry and exit" },
                { name: "Security", description: "Alerts, incidents, watchlist, lockdown" },
                { name: "Notifications", description: "User notifications" },
                { name: "Devices", description: "Cameras, access points, devices and integrations" },
                { name: "Reports", description: "Reporting and exports" },
                { name: "Admin", description: "Settings, audit, dashboard" },
            ],
        },
    });
    await app.register(swaggerUi, {
        routePrefix: "/docs",
        uiConfig: { docExpansion: "list", deepLinking: true },
    });
});
