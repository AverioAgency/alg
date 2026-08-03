# ALG — Auftrags Lead Generator

Backend for a multi-tenant system that turns a natural-language search request into
a filtered, enriched and scored lead list, and runs multi-step GDPR-compliant
outreach from it.

**No frontend lives here.** The UI is a separate Next.js app (Nexoro/OMS cluster) in
another repository. The interface to it is: the REST API, the OpenAPI 3.1 document
at `GET /v1/openapi.json`, and the `@alg/shared` package.

## Core concepts

- **Target type** (`local_business | company | person | list`) decides which
  discovery adapters and signal providers are even eligible for a search.
- **Signal provider** produces named facts about an entity (`web.presence.has_website`,
  `legal.impressum.*`). Providers declare what they produce, what they depend on,
  what they cost and how long the result stays fresh — and they only run when
  something references them.
- **Rubric** turns signals into a score: weighted criteria, hard exclusions, an
  optional LLM stage, and a threshold. It is data, not code.
- **Playbook** is a preconfigured bundle (search + rubric + sequence) that a user
  can start from.

The system has no built-in notion of a good lead. One user wants businesses without
a website, the next wants ERP replacement candidates, the third just wants
restaurants in Upper Austria — all three run through the same engine with no code
change. If you find yourself hardcoding "website quality" or "restaurant" anywhere,
it belongs in a provider, a rubric or a playbook instead.

## Repository layout

```
apps/
  api/        Express 5 server, routes, middleware, OpenAPI
  worker/     BullMQ consumers for every queue
  scraper/    Playwright service, internal only, no public port (Playwright lands in M2)
packages/
  shared/     Zod schemas + types. ALSO CONSUMED BY THE FRONTEND.
  db/         Drizzle schema, migrations, withWorkspace guard
  core/       Domain logic: storage, kill switch; planner/scoring/sequences follow
  adapters/   discovery/, signals/, channels/ (from M1 on)
infra/
  docker/     One Dockerfile per service
  scripts/    backup.sh, restore-test.sh, seed.ts
tools/
  eslint-rules/  Custom lint rules, incl. the workspace guard
```

## Commands

```bash
pnpm install            # requires Node >= 26 and pnpm 10 (corepack enable)
pnpm dev                # all services in watch mode
pnpm build              # packages first, then apps (tsc project references)
pnpm typecheck          # tsc -b across the whole monorepo
pnpm lint               # eslint, including alg/no-raw-drizzle-query
pnpm test               # vitest
pnpm format             # prettier

pnpm migrate            # apply migrations (needs DATABASE_URL)
pnpm migrate:generate   # generate a migration from the Drizzle schema
pnpm seed               # demo workspace + companies, refuses to run in production

pnpm docker:up          # docker compose up -d
pnpm docker:logs
```

Local Postgres is optional — the `postgres` service sits behind the `local-db`
profile. Point `DATABASE_URL` at the self-hosted Supabase instead:
`docker compose -f infra/docker-compose.yml --profile local-db up -d`.

## Pitfalls

Things that will bite, roughly in order of how expensive the mistake is:

- **Never create RLS policies.** Supabase is used as a plain Postgres. There is no
  anon key in circulation and the frontend never talks to the database. All
  authorization happens in the API layer. An RLS policy here would give false
  confidence and conflict with the service-role connection.
- **`withWorkspace()` is mandatory.** Every Drizzle query goes through it — it is
  the _only_ thing enforcing tenant isolation. The `alg/no-raw-drizzle-query`
  ESLint rule fails the build on a raw `db.select()`. Genuinely global queries use
  `withoutWorkspaceScope(reason, fn)` and must state a reason.
- **Respect the kill switch.** Every `ChannelAdapter.send()` calls
  `assertSendingEnabled()` first. `ALG_SENDING_ENABLED=false` in staging and test,
  and staging refuses to boot with it enabled.
- **No live API calls in tests.** Every adapter and provider gets a contract test
  against fixtures. msw for HTTP, testcontainers for Postgres/Redis.
- **`@alg/shared` must stay frontend-safe.** No `node:*`, no Drizzle, no Buffer, no
  secrets — it is bundled into the Next.js app. `no-server-imports.test.ts` enforces
  this; breaking it fails in the _other_ repository, which is a bad place to find out.
- **Files only ever go through `FileStorage`.** Paths are derived from the `files`
  table, never from request input. `GET /v1/files/:id` checks workspace membership;
  `GET /v1/r/:token` verifies an HMAC token that carries a file id and an expiry —
  never a path. Traefik does not serve the storage directory.
- **Backups cover the database _and_ the storage directory.** A `pg_dump` alone
  leaves a catalogue of documents that no longer exist.
- **Migrations are forward-compatible.** Never drop a column in the same deploy as
  the code that stops using it.
- **User-visible strings are German, via i18n keys.** Code, identifiers and comments
  are English. Never hardcode German text in a handler.

## Conventions

- Zod at every system boundary: request, response, ENV, adapter output.
- Errors follow RFC 9457 (`application/problem+json`) with stable `type` slugs from
  `PROBLEM_TYPES`. The frontend branches on these — treat them as public API.
- Long-running operations return `202 { run_id }`; progress via SSE on
  `GET /v1/streams/:runId`.
- Every mutating endpoint accepts `Idempotency-Key`.
- Cursor pagination only, never offset.
- No `any`. No `as` without a comment explaining why.
- Configuration only via validated ENV. Prices and rate limits go in a versioned,
  dated config file — not in code.
- pino with PII redaction. No personal data in logs or Sentry.

## Status

**M0 complete** — monorepo, `@alg/shared` contracts, Drizzle schema and first
migration, `withWorkspace` guard plus its ESLint rule, `LocalFileStorage` with
atomic writes and traversal defence, Express skeleton with auth/rate
limiting/idempotency/problem+json, `/v1/health` including storage fill level,
`/v1/files/:id` and `/v1/r/:token`, worker with the retention cron, scraper stub,
Docker Compose with Traefik, backup and restore-test scripts, CI on Node 26 with a
24 LTS fallback job.

**M1 next** — discovery: adapter interface, Overpass / Google Places / CSV import,
normalization to `RawEntity`, the dedupe cascade (place_id → domain → E.164 phone →
trigram fuzzy on name+postcode at 0.85), companies/contacts endpoints with cursor
pagination, and the `discovery` BullMQ queue with SSE progress.
