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
        FilterNode: {
          type: "object",
          description:
            "Recursive AND/OR/NOT tree. A branch has op and children, a negation has op:not and child, a leaf has op, key and value.",
          properties: {
            op: {
              type: "string",
              enum: [
                "and",
                "or",
                "not",
                "eq",
                "neq",
                "lt",
                "lte",
                "gt",
                "gte",
                "in",
                "nin",
                "contains",
                "intersects",
                "exists",
                "within",
              ],
            },
            children: { type: "array", items: { $ref: "#/components/schemas/FilterNode" } },
            child: { $ref: "#/components/schemas/FilterNode" },
            key: {
              type: "string",
              description: "Dotted signal path, e.g. web.presence.has_website",
            },
            value: {},
          },
          required: ["op"],
        },
        SearchSpec: {
          type: "object",
          properties: {
            targetType: {
              type: "string",
              enum: ["local_business", "company", "person", "list"],
            },
            filters: { $ref: "#/components/schemas/FilterNode" },
            limit: { type: "integer", minimum: 1, maximum: 10000 },
            sources: {
              type: "array",
              items: { type: "string" },
              description: "Empty means the planner picks the adapters.",
            },
          },
          required: ["targetType", "filters"],
        },
        Company: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            target_type: { type: "string" },
            name: { type: "string" },
            domain: { type: "string", nullable: true },
            website: { type: "string", nullable: true },
            phone: { type: "string", nullable: true, description: "E.164" },
            email: { type: "string", nullable: true },
            address: {
              type: "object",
              properties: {
                street: { type: "string", nullable: true },
                house_number: { type: "string", nullable: true },
                postal_code: { type: "string", nullable: true },
                city: { type: "string", nullable: true },
                region: { type: "string", nullable: true },
                country: { type: "string", nullable: true },
              },
            },
            geo: {
              type: "object",
              nullable: true,
              properties: { lat: { type: "number" }, lon: { type: "number" } },
            },
            dedupe: {
              type: "object",
              nullable: true,
              description: "Which cascade stage matched this record, and how confidently.",
              properties: {
                stage: {
                  type: "string",
                  enum: ["source_id", "domain", "phone", "fuzzy_name"],
                },
                confidence: { type: "number", nullable: true },
              },
            },
            sources: {
              type: "array",
              description: "Provenance. Present on the detail endpoint only.",
              items: {
                type: "object",
                properties: {
                  source_id: { type: "string" },
                  external_id: { type: "string", nullable: true },
                  source_url: { type: "string", nullable: true },
                  fetched_at: { type: "string", format: "date-time" },
                },
              },
            },
            last_seen_at: { type: "string", format: "date-time", nullable: true },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
          required: ["id", "name", "target_type", "created_at"],
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
      "/companies": {
        get: {
          summary: "List companies (keyset pagination)",
          parameters: [
            { name: "cursor", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
            { name: "q", in: "query", schema: { type: "string" }, description: "Name substring" },
            { name: "city", in: "query", schema: { type: "string" } },
            { name: "postal_code", in: "query", schema: { type: "string" } },
            {
              name: "country",
              in: "query",
              schema: { type: "string", minLength: 2, maxLength: 2 },
            },
            {
              name: "has_website",
              in: "query",
              schema: { type: "string", enum: ["true", "false"] },
            },
          ],
          responses: {
            "200": {
              description: "A page of companies",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: { type: "array", items: { $ref: "#/components/schemas/Company" } },
                      nextCursor: { type: "string", nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/companies/{id}": {
        get: {
          summary: "One company, including its provenance",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": {
              description: "Company with sources",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Company" } },
              },
            },
            "404": { $ref: "#/components/responses/Problem" },
          },
        },
      },
      "/companies/{id}/contacts": {
        get: {
          summary: "Contacts of one company",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: { "200": { description: "Contacts" } },
        },
      },
      "/contacts": {
        get: {
          summary: "List contacts (keyset pagination)",
          parameters: [
            { name: "cursor", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "q", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "A page of contacts" } },
        },
      },
      "/searches": {
        get: {
          summary: "List saved searches",
          responses: { "200": { description: "A page of searches" } },
        },
        post: {
          summary: "Create a search",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "spec"],
                  properties: {
                    name: { type: "string" },
                    spec: { $ref: "#/components/schemas/SearchSpec" },
                    is_monitor: { type: "boolean", default: false },
                    monitor_cron: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Created" },
            "400": { $ref: "#/components/responses/Problem" },
          },
        },
      },
      "/searches/{id}": {
        get: {
          summary: "One search",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": { description: "Search" },
            "404": { $ref: "#/components/responses/Problem" },
          },
        },
        patch: {
          summary: "Update a search",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: { "200": { description: "Updated" } },
        },
        delete: {
          summary: "Delete a search - its runs are kept",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: { "204": { description: "Deleted" } },
        },
      },
      "/searches/{id}/run": {
        post: {
          summary: "Start a discovery run",
          description:
            "Returns immediately with a run id. Progress is delivered over SSE on /v1/streams/{run_id}.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            { name: "Idempotency-Key", in: "header", schema: { type: "string" } },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    limit: { type: "integer", minimum: 1, maximum: 10000 },
                    budget_eur: {
                      type: "number",
                      description: "Hard ceiling; paid adapters are skipped rather than exceed it.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "202": {
              description: "Run queued",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      run_id: { type: "string", format: "uuid" },
                      status: { type: "string" },
                      stream_url: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/searches/{id}/runs": {
        get: {
          summary: "Runs of one search",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: { "200": { description: "Runs" } },
        },
      },
      "/runs/{id}": {
        get: {
          summary: "One run, with counters and cost",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": { description: "Run" },
            "404": { $ref: "#/components/responses/Problem" },
          },
        },
      },
      "/streams/{runId}": {
        get: {
          summary: "Server-sent progress for a run",
          description:
            "text/event-stream. Send Last-Event-ID to resume after a dropped connection; the sequence number is the event id.",
          parameters: [
            {
              name: "runId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            { name: "Last-Event-ID", in: "header", schema: { type: "integer" } },
          ],
          responses: {
            "200": {
              description: "Event stream",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            "404": { $ref: "#/components/responses/Problem" },
          },
        },
      },
    },
  }
}
