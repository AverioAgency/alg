/**
 * OpenAPI 3.1 description of the public surface. This is a contract with the
 * Next.js frontend, which generates its client from it - so every route added in a
 * later milestone gets an entry here in the same commit.
 */
export function openApiDocument(version: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "ALG API",
      version,
      description:
        "Auftrags Lead Generator. Multi-tenant lead discovery, enrichment, scoring and outreach.",
    },
    servers: [{ url: "/v1" }],
    security: [{ bearerAuth: [], workspaceHeader: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Supabase-issued access token.",
        },
        workspaceHeader: {
          type: "apiKey",
          in: "header",
          name: "x-workspace-id",
          description: "Workspace the request operates on. Membership is verified per request.",
        },
      },
      schemas: {
        Problem: {
          type: "object",
          description: "RFC 9457 problem details.",
          properties: {
            type: { type: "string", format: "uri" },
            title: { type: "string" },
            status: { type: "integer" },
            detail: { type: "string" },
            instance: { type: "string" },
            requestId: { type: "string" },
            errors: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  message: { type: "string" },
                  code: { type: "string" },
                },
              },
            },
          },
          required: ["type", "title", "status"],
        },
        StorageUsage: {
          type: "object",
          properties: {
            usedBytes: { type: "integer" },
            maxBytes: { type: "integer" },
            usedPercent: { type: "number" },
            overSoftLimit: { type: "boolean" },
          },
          required: ["usedBytes", "maxBytes", "usedPercent", "overSoftLimit"],
        },
        Health: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["ok", "degraded", "down"] },
            version: { type: "string" },
            uptimeSeconds: { type: "integer" },
            sendingEnabled: { type: "boolean" },
            storage: { $ref: "#/components/schemas/StorageUsage" },
          },
          required: ["status", "version", "uptimeSeconds", "sendingEnabled", "storage"],
        },
      },
      responses: {
        Problem: {
          description: "Error",
          content: {
            "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
          },
        },
      },
    },
    paths: {
      "/health": {
        get: {
          summary: "Liveness and storage fill level",
          security: [],
          responses: {
            "200": {
              description: "Service state",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Health" } },
              },
            },
          },
        },
      },
      "/ready": {
        get: {
          summary: "Readiness - checks Postgres, Redis and storage",
          security: [],
          responses: {
            "200": { description: "Ready" },
            "503": { description: "Not ready" },
          },
        },
      },
      "/files/{id}": {
        get: {
          summary: "Download a file belonging to the caller's workspace",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": {
              description: "File contents",
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
              },
            },
            "404": { $ref: "#/components/responses/Problem" },
          },
        },
      },
      "/r/{token}": {
        get: {
          summary: "Public, signed, expiring file link",
          security: [],
          parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "File contents",
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
              },
            },
            "403": { $ref: "#/components/responses/Problem" },
          },
        },
      },
    },
  }
}
