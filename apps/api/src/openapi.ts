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
        Operator: {
          type: "string",
          description:
            "Leaf comparison operators. Shared by search filters and rubric criteria, so a condition means the same thing in both. `exists` is unary and ignores value.",
          enum: [
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
        Rubric: {
          type: "object",
          description:
            "A rubric is data, not code. The engine has no built-in notion of a good lead - what makes one is entirely what this document says.",
          properties: {
            criteria: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Shown to the user, in German." },
                  signal: {
                    type: "string",
                    description: "A key from GET /v1/signals/schema.",
                  },
                  condition: {
                    type: "object",
                    properties: {
                      op: { $ref: "#/components/schemas/Operator" },
                      value: {},
                    },
                    required: ["op", "value"],
                  },
                  weight: {
                    type: "integer",
                    minimum: -100,
                    maximum: 100,
                    description:
                      "Negative penalizes. Zero means compute the signal but do not rank on it - which is how a market-research rubric collects data without producing a ranking.",
                  },
                  hard: {
                    type: "boolean",
                    description:
                      "Failing a hard criterion excludes the lead outright, whatever else it scores.",
                  },
                },
                required: ["label", "signal", "condition", "weight"],
              },
            },
            llmCriteria: {
              type: "array",
              description:
                "Optional LLM stage. Without ANTHROPIC_API_KEY it is skipped and llm stays null on the score.",
              items: {
                type: "object",
                properties: {
                  prompt: { type: "string" },
                  weight: { type: "integer", minimum: -100, maximum: 100 },
                },
                required: ["prompt", "weight"],
              },
            },
            threshold: {
              type: "number",
              description: "Minimum total for a lead to qualify.",
            },
          },
          required: ["criteria", "threshold"],
        },
        OnboardingProfile: {
          type: "object",
          description:
            'What the workspace answered in the onboarding wizard. Every field is optional — a half-finished profile is normal, and a missing answer means "ask me", never "no". `target.region` and `target.categories` are the two that feed back into every later search.',
          properties: {
            company: {
              type: "object",
              description: "Context for the LLM stage, not a filter.",
              properties: {
                name: { type: "string" },
                industry: { type: "string" },
                website: { type: "string" },
              },
            },
            offer: {
              type: "object",
              description: "Free text on purpose — it is the input to POST /rubrics/suggest.",
              properties: {
                description: { type: "string", maxLength: 4000 },
                rubric_id: { type: "string", format: "uuid" },
              },
            },
            target: {
              type: "object",
              description: "The part that pre-fills later searches.",
              properties: {
                targetType: {
                  type: "string",
                  enum: ["local_business", "company", "person", "list"],
                },
                region: {
                  type: "string",
                  description:
                    'Region slug as used by the clarification questions, e.g. "oberoesterreich".',
                },
                categories: { type: "array", items: { type: "string" } },
                playbookSlug: { type: "string" },
              },
            },
            outreach: {
              type: "object",
              description:
                "Steps 4-6: channels, templates, compliance. Recorded but unused until M5 brings outreach; deliberately unmodelled so M5 stays free to decide the shape.",
              additionalProperties: true,
            },
            completedAt: {
              type: "string",
              format: "date-time",
              nullable: true,
              description: "Null while the wizard is still in progress.",
            },
            lastStep: { type: "integer", minimum: 1, maximum: 20 },
          },
        },
        LeadScore: {
          type: "object",
          properties: {
            total: { type: "integer", minimum: 0, maximum: 100 },
            qualified: { type: "boolean" },
            threshold: { type: "number" },
            breakdown: {
              type: "array",
              description:
                "One entry per criterion, matched or not. A score without this cannot be explained to the user.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  signal: { type: "string" },
                  actualValue: {
                    nullable: true,
                    description:
                      "null means the signal was never computed. Distinct from a signal measured as false: a failed crawl must not look like a disqualifying answer.",
                  },
                  matched: { type: "boolean" },
                  weight: { type: "number" },
                  points: { type: "number" },
                  hard: { type: "boolean" },
                  excluded: { type: "boolean" },
                },
              },
            },
            llm: {
              type: "object",
              nullable: true,
              description: "null when the stage did not run.",
              properties: {
                score: { type: "integer", minimum: 0, maximum: 100 },
                reasoning: { type: "string" },
                best_angle: { type: "string" },
                risk: { type: "string" },
              },
            },
          },
          required: ["total", "qualified", "threshold", "breakdown"],
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

      // --- M2: signals -------------------------------------------------------
      "/companies/{id}/signals": {
        get: {
          summary: "Everything ALG knows about a company, with provenance",
          description:
            "Provenance names the provider, its version and when the value was fetched. Art. 14 requires being able to name the source, and a filter decision has to stay explainable.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": { description: "Signals" },
            "404": { $ref: "#/components/responses/Problem" },
          },
        },
      },
      // --- M4: onboarding ----------------------------------------------------
      "/searches/clarify": {
        post: {
          summary: "Turn a vague request into a runnable search",
          description:
            "Returns at most four questions, chosen by what the spec is still missing. Stateless: send the description and the answers so far, get the remaining questions and the spec built from them. Every question except the category carries a default, so the wizard can always be skipped - guessing an industry would silently narrow the search to something the user never said.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["description"],
                  properties: {
                    description: { type: "string", maxLength: 2000 },
                    target_type: {
                      type: "string",
                      enum: ["local_business", "company", "person", "list"],
                    },
                    answers: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["question_id", "value"],
                        properties: {
                          question_id: { type: "string" },
                          value: {
                            description: "String, number, boolean, string array, or null.",
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Remaining questions and the spec so far",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      questions: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            type: {
                              type: "string",
                              enum: ["boolean_or_both", "single_select", "multi_select", "range"],
                            },
                            prompt_key: { type: "string" },
                            options: {
                              type: "array",
                              items: {
                                type: "object",
                                properties: {
                                  value: { type: "string" },
                                  label_key: { type: "string" },
                                  is_default: { type: "boolean" },
                                },
                              },
                            },
                            min: { type: "integer" },
                            max: { type: "integer" },
                            unit: { type: "string" },
                            default_value: {
                              nullable: true,
                              description: "null means the question cannot be skipped safely.",
                            },
                            reason_key: { type: "string" },
                          },
                        },
                      },
                      spec: { $ref: "#/components/schemas/SearchSpec" },
                      runnable: {
                        type: "boolean",
                        description:
                          "False means the spec has no geographic constraint yet; Overpass refuses outright without one.",
                      },
                      skippable: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/searches/preview": {
        post: {
          summary: "The spec a run would use, and what it would cost",
          description:
            "Separate from the run endpoint on purpose: the cost has to be visible before anything is charged. plan.empty true means no signal was referenced, so no provider runs and the search is free - that is demand-driven execution, not a failure. Signals referenced by an attached rubric are planned exactly like filter references.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["description"],
                  properties: {
                    description: { type: "string" },
                    target_type: { type: "string" },
                    answers: { type: "array", items: { type: "object" } },
                    rubric: { $ref: "#/components/schemas/Rubric" },
                    fill_defaults: { type: "boolean", default: true },
                    estimated_entities: { type: "integer", minimum: 1, maximum: 100000 },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Spec, plan and cost",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      spec: { $ref: "#/components/schemas/SearchSpec" },
                      runnable: { type: "boolean" },
                      share_query: {
                        type: "string",
                        description: "Query string that decodes back to this exact spec.",
                      },
                      applied_defaults: { type: "array", items: { type: "object" } },
                      unanswered: { type: "array", items: { type: "string" } },
                      plan: {
                        type: "object",
                        properties: {
                          providers: { type: "array", items: { type: "object" } },
                          empty: { type: "boolean" },
                          unresolved: { type: "array", items: { type: "string" } },
                        },
                      },
                      cost: {
                        type: "object",
                        properties: {
                          entities: { type: "integer" },
                          per_entity_eur: { type: "number" },
                          total_eur: { type: "number" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/searches/encode": {
        post: {
          summary: "Encode a spec as a shareable query string",
          description:
            "Readable parameters (category, city, bbox) for the common shape; a base64url blob in `q` for anything a flat parameter list cannot express - an OR branch, a negation, a signal filter. The round trip is guaranteed: decoding always returns the same spec, which is why a bare leaf uses the opaque form rather than coming back wrapped in an AND. Pass opaque: true to force it.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["spec"],
                  properties: {
                    spec: { $ref: "#/components/schemas/SearchSpec" },
                    opaque: { type: "boolean", default: false },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Query string" } },
        },
      },
      "/searches/decode": {
        post: {
          summary: "Decode a shared search URL back into a spec",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["query"],
                  properties: { query: { type: "string", maxLength: 8000 } },
                },
              },
            },
          },
          responses: {
            "200": { description: "Spec" },
            "400": { $ref: "#/components/responses/Problem" },
          },
        },
      },
      "/onboarding": {
        get: {
          summary: "Whether this workspace has been through onboarding",
          description:
            "The frontend calls this on every visit to decide whether to offer the wizard. `completed: false` with a null profile means it was never started; a `completed_at` means the user reached the end and the entry point disappears. `last_step` lets an interrupted run resume where it stopped rather than restarting.",
          responses: {
            "200": {
              description: "Onboarding state",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      profile: {
                        $ref: "#/components/schemas/OnboardingProfile",
                        nullable: true,
                      },
                      completed: { type: "boolean" },
                      completed_at: { type: "string", format: "date-time", nullable: true },
                      last_step: { type: "integer", nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
        patch: {
          summary: "Save wizard progress, and on the last step mark it done",
          description:
            'Merged, not replaced — the wizard saves after each step, and a request carrying only step 3 must not erase what step 2 recorded. `completed: true` stamps `completed_at` once; a later save never rewrites or clears it. What the profile records is not just a flag: region and categories pre-fill the clarification questions on every later search, so a user who said "Oberösterreich, Handwerk" is not asked again each time.',
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    profile: { $ref: "#/components/schemas/OnboardingProfile" },
                    last_step: { type: "integer", minimum: 1, maximum: 20 },
                    completed: { type: "boolean", default: false },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Stored state" },
            "400": { $ref: "#/components/responses/Problem" },
          },
        },
        delete: {
          summary: "Start onboarding over",
          description:
            "Clears the profile entirely, not just the timestamp: a user asking to redo onboarding means the answers too, and keeping them would silently pre-fill the very questions they wanted to revisit.",
          responses: { "204": { description: "Cleared" } },
        },
      },
      "/playbooks": {
        get: {
          summary: "Preconfigured starting points",
          description:
            "Three playbooks covering three incompatible notions of a good lead - selling websites, replacing an ERP, and market research where every weight is zero. Same engine, no code branching on any of them. `sequence` is null until M5 lands; it is not an empty object, because nothing should suggest messaging exists.",
          responses: { "200": { description: "Playbooks" } },
        },
      },
      "/playbooks/{slug}/start": {
        post: {
          summary: "Instantiate a playbook into the workspace",
          description:
            "Creates the search and the rubric and returns both ids, so onboarding is one call rather than three. Everything created is ordinary data the user can edit or delete - a playbook is a starting point, not a binding template.",
          parameters: [
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
            { name: "Idempotency-Key", in: "header", schema: { type: "string" } },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string", maxLength: 160 } },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Search and rubric created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      playbook: { type: "string" },
                      search_id: { type: "string", format: "uuid" },
                      rubric_id: { type: "string", format: "uuid" },
                      next: {
                        type: "object",
                        properties: {
                          run_search: { type: "string" },
                          score: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
            "404": { $ref: "#/components/responses/Problem" },
          },
        },
      },
      "/filters/schema": {
        get: {
          summary: "Everything the filter UI can offer, in one document",
          description:
            "Merges three sources the frontend would otherwise have to know about separately: the core.* fields discovery supplies (always free), the signals providers produce (priced per entity - referencing one in a filter is what makes its provider run), and the category vocabulary. pushed_down_by names the adapters that can pre-filter at the source; an empty list means the adapter fetches first and filters afterwards, which on a paid source costs more.",
          parameters: [
            {
              name: "target_type",
              in: "query",
              description: "Omit to get every field and category.",
              schema: {
                type: "string",
                enum: ["local_business", "company", "person", "list"],
              },
            },
          ],
          responses: {
            "200": {
              description: "Filter schema",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      target_type: { type: "string", nullable: true },
                      fields: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            key: { type: "string" },
                            kind: { type: "string", enum: ["core", "signal"] },
                            type: {
                              type: "string",
                              enum: [
                                "boolean",
                                "number",
                                "string",
                                "string_array",
                                "date",
                                "object",
                              ],
                            },
                            operators: {
                              type: "array",
                              items: { $ref: "#/components/schemas/Operator" },
                            },
                            label_key: {
                              type: "string",
                              description: "i18n key; the German string lives in the frontend.",
                            },
                            enum_values: { type: "array", items: { type: "string" } },
                            unit: { type: "string" },
                            pushed_down_by: { type: "array", items: { type: "string" } },
                            cost_per_entity_eur: { type: "number" },
                          },
                        },
                      },
                      categories: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            slug: { type: "string" },
                            label_key: { type: "string" },
                            target_type: { type: "string" },
                          },
                        },
                      },
                      operators: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Operator" },
                      },
                      unary_operators: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Operator" },
                        description:
                          "Operators that take no value; render no value input for these.",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/signals/schema": {
        get: {
          summary: "What the registry can produce, for the filter UI",
          parameters: [
            {
              name: "target_type",
              in: "query",
              schema: {
                type: "string",
                enum: ["local_business", "company", "person", "list"],
              },
            },
          ],
          responses: { "200": { description: "Providers and signal definitions" } },
        },
      },
      "/signals/preview": {
        post: {
          summary: "Resolve the signal plan and its cost without running anything",
          description:
            "The demand-driven property made visible: a spec that references no signal returns an empty plan and a cost of zero.",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    spec: { type: "object" },
                    rubric: { type: "object" },
                    template_variables: { type: "array", items: { type: "string" } },
                    entities: { type: "integer", minimum: 1, maximum: 100000 },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Plan, references and cost" } },
        },
      },
      "/enrichments": {
        post: {
          summary: "Start an enrichment run",
          description: "Returns 202 with a run id. Poll /v1/enrichments/{id} for progress.",
          parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" } }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    company_ids: {
                      type: "array",
                      items: { type: "string", format: "uuid" },
                      maxItems: 1000,
                    },
                    all: { type: "boolean" },
                    spec: { type: "object" },
                    rubric: { type: "object" },
                    template_variables: { type: "array", items: { type: "string" } },
                    force: {
                      type: "boolean",
                      description: "Ignores cached values that are still fresh.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "202": { description: "Run queued" },
            "400": { $ref: "#/components/responses/Problem" },
          },
        },
        get: {
          summary: "Recent enrichment runs",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
          ],
          responses: { "200": { description: "Runs" } },
        },
      },
      "/enrichments/{id}": {
        get: {
          summary: "One enrichment run, with counters",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": { description: "Run" },
            "404": { $ref: "#/components/responses/Problem" },
          },
        },
      },

      // --- M3: scoring -------------------------------------------------------
      "/rubrics": {
        post: {
          summary: "Create a rubric",
          description:
            "A criterion referencing a signal no provider produces is rejected here rather than silently scoring every lead at zero.",
          parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "target_type", "definition"],
                  properties: {
                    name: { type: "string", maxLength: 160 },
                    description: { type: "string" },
                    target_type: {
                      type: "string",
                      enum: ["local_business", "company", "person", "list"],
                    },
                    definition: { $ref: "#/components/schemas/Rubric" },
                    template_slug: { type: "string" },
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
        get: {
          summary: "List rubrics",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
            {
              name: "target_type",
              in: "query",
              schema: {
                type: "string",
                enum: ["local_business", "company", "person", "list"],
              },
            },
            { name: "include_archived", in: "query", schema: { type: "boolean" } },
          ],
          responses: { "200": { description: "Rubrics" } },
        },
      },
      "/rubrics/templates": {
        get: {
          summary: "Seeded starting points",
          description:
            "Website sales, ERP replacement and market research. The three demonstrate that the engine has no built-in notion of a good lead.",
          responses: { "200": { description: "Templates" } },
        },
      },
      "/rubrics/suggest": {
        post: {
          summary: "Draft a rubric from a free-text description",
          description:
            "not_covered lists what the description asked for that no available signal can express - stated rather than approximated with a proxy. 503 with type llm-not-configured when ANTHROPIC_API_KEY is unset; author the rubric manually in that case.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["description"],
                  properties: {
                    description: { type: "string", minLength: 10, maxLength: 4000 },
                    target_type: {
                      type: "string",
                      enum: ["local_business", "company", "person", "list"],
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Draft rubric",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      definition: { $ref: "#/components/schemas/Rubric" },
                      not_covered: { type: "array", items: { type: "string" } },
                      rationale: { type: "string" },
                    },
                  },
                },
              },
            },
            "502": { $ref: "#/components/responses/Problem" },
            "503": { $ref: "#/components/responses/Problem" },
          },
        },
      },
      "/rubrics/{id}": {
        get: {
          summary: "One rubric, with the signals it references",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": { description: "Rubric" },
            "404": { $ref: "#/components/responses/Problem" },
          },
        },
        patch: {
          summary: "Edit a rubric",
          description:
            "A definition change bumps the version; existing scores keep the version they were computed with and are reported as stale rather than deleted, so hand-labelled feedback survives.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": { description: "Updated" },
            "404": { $ref: "#/components/responses/Problem" },
          },
        },
        delete: {
          summary: "Archive a rubric",
          description: "Archived, not deleted: existing scores must stay explainable.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: { "204": { description: "Archived" } },
        },
      },
      "/rubrics/{id}/score": {
        post: {
          summary: "Score companies against this rubric",
          description:
            "Returns 202 with a run id. llm_stage reports whether the LLM stage will run: not_used, enabled, or skipped_no_key.",
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
                    company_ids: {
                      type: "array",
                      items: { type: "string", format: "uuid" },
                      maxItems: 1000,
                    },
                    all: { type: "boolean" },
                    force: {
                      type: "boolean",
                      description: "Rescores companies already current for this rubric version.",
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
                      companies: { type: "integer" },
                      llm_stage: {
                        type: "string",
                        enum: ["not_used", "enabled", "skipped_no_key"],
                      },
                    },
                  },
                },
              },
            },
            "400": { $ref: "#/components/responses/Problem" },
          },
        },
      },
      "/scoring-runs/{id}": {
        get: {
          summary: "One scoring run, with counters and token usage",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": { description: "Run" },
            "404": { $ref: "#/components/responses/Problem" },
          },
        },
      },
      "/rubrics/{id}/leads": {
        get: {
          summary: "The ranked lead list",
          description:
            "Keyset pagination on (total, id). A score computed with an older rubric version is returned with stale: true rather than hidden.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
            { name: "qualified_only", in: "query", schema: { type: "boolean" } },
          ],
          responses: {
            "200": { description: "Ranked leads with their breakdown" },
            "404": { $ref: "#/components/responses/Problem" },
          },
        },
      },
      "/rubrics/{id}/leads/{companyId}/feedback": {
        put: {
          summary: "Record the user's verdict on one lead",
          description: "The input to threshold calibration. Send null to clear.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            {
              name: "companyId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["feedback"],
                  properties: {
                    feedback: { type: "string", enum: ["good", "bad"], nullable: true },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Updated score" },
            "404": { $ref: "#/components/responses/Problem" },
          },
        },
      },
      "/rubrics/{id}/calibration": {
        get: {
          summary: "Suggest a corrected threshold from hand-labelled leads",
          description:
            "Arithmetic, not an LLM call. reliable is false when there is too little labelled data (fewer than 8 samples, or only one side labelled) - the frontend must not present the number as advice in that case. suspect_criteria distinguishes inverted (the criterion points the wrong way), no_signal (it carries no information) and never_measured (no data, so the provider is the problem, not the rubric).",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": { description: "Calibration result" },
            "404": { $ref: "#/components/responses/Problem" },
          },
        },
      },
    },
  }
}
