# ALG — Auftrags Lead Generator

Backend for a multi-tenant system that turns a natural-language search request into
a filtered, enriched and scored lead list, and runs multi-step GDPR-compliant
outreach from it.

**No frontend lives here.** The UI is a separate Next.js app (Nexoro/OMS cluster) in
another repository. The interface to it is: the REST API, the OpenAPI 3.1 document
at `GET /v1/openapi.json`, and the `@alg/shared` package.

A human-readable reference of every endpoint is served at `GET /docs`
(<https://alg-nexoro.averio.agency/docs>) — generated from the same OpenAPI
document, so it cannot describe a route that does not exist.

Two ways in, both ending at the same `req.ctx`: a Supabase JWT plus
`x-workspace-id`, or — for the Nexoro PHP backend — a service token plus the
acting user, with the workspace resolved from the subdomain. `infra/FRONTEND.md`
has the integration guide.

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
  scraper/    Internal service, no public port. Playwright is deferred - the
              HTTP-based providers in M2 do not need it.
packages/
  shared/     Zod schemas + types. ALSO CONSUMED BY THE FRONTEND.
  db/         Drizzle schema, migrations, withWorkspace guard
  core/       Domain logic: storage, kill switch, discovery (normalize, dedupe,
              orchestration), signals (registry, planner, enrichment), crawler
  adapters/
    discovery/  Overpass, Google Places, CSV import
    signals/    web.presence, legal.impressum, web.techstack, contact.basic
                channels/ arrives with M5
infra/
  docker/     One Dockerfile per service
  scripts/    backup.sh, restore-test.sh, seed.ts
tools/
  eslint-rules/  Custom lint rules, incl. the workspace guard
```

## Commands

```bash
pnpm install            # requires Node >= 26 and pnpm 10 (npm i -g pnpm@10.15.0)
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

- **A new package needs four edits, not one.** Adding a workspace package means:
  the dependency in the consuming `package.json`, a `references` entry in its
  `tsconfig.json`, a `--filter` in the Dockerfiles' build step, and the `dist` /
  `package.json` / `node_modules` COPY lines in the runtime stage. `pnpm build`
  at the root resolves everything and therefore hides a missing reference — the
  Dockerfiles build with `--filter` and do not. CI now builds both ways.
- **Node 26 has no Corepack.** It was removed from the distribution in Node 25, so
  `corepack enable` fails with `command not found`. The Dockerfiles install pnpm
  from npm instead — keep that version in sync with the `packageManager` field.
- **Pin exact image tags and verify they exist.** `node:26.0.1` was never
  published; the build failed with a 404 on the base image. Check first:
  `curl -sI https://hub.docker.com/v2/repositories/library/node/tags/<tag>`
- **Don't guess which tag names carry meaning — record the shape, don't re-derive
  it.** `renderOverpassQl` decided what was a category selector by matching the
  tag name against a fixed regex (`amenity|shop|tourism|office|leisure`).
  Categories union, everything else intersects, so when M4 added `man_made` and
  `landuse` an `industrial` search silently became an AND of two tags and matched
  nothing — no error, just zero results. The planner now records
  `categoryFilters` instead.
- **Overpass's public endpoint is unreliable under load, and says so in HTML.**
  The same query that returned 635 objects failed minutes later with an XHTML
  error page, not JSON. That is what the retry-and-mirror logic in the adapter is
  for; when measuring by hand, query serially (the rate limit is 2) and expect to
  fall back to `overpass.kumi.systems`.

- **Ein Nachfilter, der alles verwirft, sieht aus wie eine leere Gegend.** Der
  Adapter liefert 500 Objekte, `evaluateFilter` verwirft jedes, und der Lauf
  meldet `found: 0` ohne Fehler — ununterscheidbar von "dort gibt es nichts".
  Genau das passierte, weil `core.category` mehrwertig ist (ein Lokal ist
  restaurant *und* cafe), der Nutzerfilter aber einwertig, und `looseEquals`
  den Array-Fall nicht kannte. `evaluateFilter` hatte trotz dieser Stellung
  keinen einzigen Test. Der Lauf berichtet jetzt `returned` neben `found` — die
  Differenz benennt sofort, ob die Quelle oder der Filter schuld ist.
- **Auf dem Server läuft `./infra/alg.sh`, nicht `docker compose`.** ALG braucht
  zwei Compose-Dateien; die zweite hängt die Container ins Supabase-Netz. Fehlt
  sie, ist der Fehler nicht "Netzwerk fehlt", sondern `getaddrinfo EAI_AGAIN`
  und HTTP 500 auf jeder Route mit Datenbankzugriff, während `/health` und
  `/docs` weiterlaufen — es sieht nach einem Anwendungsfehler aus und ist
  keiner. `export COMPOSE_FILE=...` überlebt keinen Reconnect, das Skript schon.
- **Jeder neue Auth-Header gehört in `REDACT_PATHS`.** `x-alg-service-token`
  stand im Klartext in jeder Zeile des Request-Logs, weil die Liste nur
  `x-supabase-token` kannte — und pino-http loggt Header vollständig. Ein Log
  wandert weiter als der Prozess, der es schreibt (aufgefallen ist es, als ein
  Fehlerlog zum Debuggen weitergereicht wurde).
- **Never create RLS policies.** Supabase is used as a plain Postgres. There is no
  anon key in circulation and the frontend never talks to the database. All
  authorization happens in the API layer. An RLS policy here would give false
  confidence and conflict with the service-role connection.
- **`ALG_SERVICE_TOKEN` is a tenant boundary, not a convenience.** The Nexoro PHP
  backend authenticates its own users and calls ALG server-to-server with this
  secret, naming the acting user and tenant. Whoever holds it can act for any
  workspace, which is sound only because it lives on a server we operate. It must
  never reach a browser, and the hostname alone never grants anything — the
  subdomain only _names_ a workspace, presenting the secret is what authorises
  using it. Unset disables the whole path; there is deliberately no weaker
  fallback. See `infra/FRONTEND.md`.
- **A hostname is attacker-controlled input.** Anyone can send any `Host` header.
  `tenantSlugFromHost()` in `@alg/shared` is strict on purpose: one label only
  (so `nexoro.evil.nexoro.net` is not the `nexoro` tenant), a reserved-name list
  (so `admin.nexoro.net` never becomes a workspace), and the first value only
  when a proxy appends several. Auto-provisioning a workspace per subdomain is
  only safe behind those checks — loosen one and an unknown host starts writing
  rows.
- **CORS defaults to closed, and `*` is ignored rather than honoured.** This API
  serves lead data under GDPR; a wildcard on an authenticated origin is worth
  more to an attacker than to us. Browsers also refuse `*` together with
  credentials, so it would not even work.
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
- **A new route is not finished until `openapi.ts` describes it.** Two things are
  generated from that document and nothing else: the frontend's client, in the
  other repository, and the reference page at `GET /docs`. A missing entry means
  the endpoint is invisible to whoever builds the UI; a stale entry means a
  generated client method that 404s at runtime. `openapi-coverage.test.ts` fails
  the build in either direction, so this is enforced rather than remembered —
  but write the entry in the same commit as the route, not afterwards.

  The `/docs` page itself needs no maintenance: it renders whatever the document
  says. What does need care is the **grouping** in `apps/api/src/docs.ts` — a
  route matching no section lands in "Weitere", which is the page telling you it
  does not know where the endpoint belongs. Give it a section rather than leaving
  it there.

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

**M0 complete and deployed** — monorepo, `@alg/shared` contracts, Drizzle schema
and first migration, `withWorkspace` guard plus its ESLint rule, `LocalFileStorage`
with atomic writes and traversal defence, Express skeleton with auth/rate
limiting/idempotency/problem+json, `/v1/health` including storage fill level,
`/v1/files/:id` and `/v1/r/:token`, worker with the retention cron, scraper stub,
backup and restore-test scripts, CI on Node 26 with a 24 LTS fallback job.

Running on averiodocker since 2026-08-03. Deployment notes in `infra/DEPLOY.md`;
the stack joins the server's existing Traefik (`edge`) and the Supabase network
rather than starting a proxy or a database of its own.

**M1 complete** — discovery end to end. `POST /v1/searches/:id/run` returns
`202 { run_id }`, the worker consumes the `discovery` queue, and progress streams
over SSE.

- **Adapters**: Overpass (free, OSM), Google Places (priced, field-masked), CSV
  import (any target type, reports skipped rows rather than dropping them).
- **Normalization**: domain, E.164 phone, company name (umlauts transliterate
  before accents fold, or "Müller" would collapse onto "Muller").
- **Dedupe cascade**: source id → domain → E.164 → trigram on name+postcode at
  0.85. The trigram implementation matches pg_trgm exactly, verified against the
  documented `similarity('word','two words') = 0.363636`; in-memory dedupe and the
  SQL index must not disagree on the same pair.
- **Orchestration**: adapters run per plan, filters they cannot push down are
  applied afterwards, a failing source does not lose the others' results, and a
  paid adapter is skipped rather than started when it would breach the budget.
- **Endpoints**: companies/contacts with keyset pagination, searches CRUD, runs,
  and `GET /v1/streams/:runId` (SSE, resumable via `Last-Event-ID`).

Migration 0001 adds `searches`, `search_runs`, `search_run_events` and the dedupe
provenance columns on `companies`.

**M2 complete** — the signal layer. Nothing runs unless something references it.

- **Registry + planner**: providers declare what they produce, depend on and cost.
  `planSignals()` collects every reference from filters, rubric criteria and
  template variables, resolves the dependency DAG and returns a topologically
  sorted plan. A search that mentions no `web.*` signal produces an empty plan and
  costs nothing — that is the M2 acceptance test, and it is what keeps a
  market-research search free.
- **Crawler**: robots.txt fetched once per host and honoured, one request per host
  at a time with a configurable delay, Crawl-delay respected but capped. Every
  request goes through `safeFetch`, so SSRF protection still applies.
- **Providers**: `web.presence` (root of the web tree), `legal.impressum` (ECG §5
  data — the most reliable contact source on an Austrian site), `web.techstack`
  (data-driven fingerprints, a new CMS is a table entry not a code change),
  `contact.basic` (consolidates contacts; Impressum beats directory data).
- **Caching**: one row per company and provider, with a TTL from the provider and
  its `provider_version`. A version bump re-runs even unexpired rows, because the
  extraction logic changed.
- **Endpoints**: `GET /v1/companies/:id/signals` with provenance,
  `GET /v1/signals/schema`, `POST /v1/signals/preview` (resolves the plan and its
  cost without running anything), `POST /v1/enrichments` → 202.

`web.quality` is deliberately absent: it needs Playwright, which is deferred.
Migration 0002 adds `enrichments` and `enrichment_runs`.

**M3 complete** — scoring. The rubric is data; nothing here knows what a good
lead is.

- **Rule evaluator**: every criterion produces a breakdown entry whether it
  matched or not, and `actualValue: null` ("never measured") stays distinct from
  a signal measured as false — otherwise a failed crawl reads as a disqualifying
  answer. Hard criteria exclude when they do _not_ match. The score is normalized
  against the sum of positive weights, so adding a criterion does not force the
  threshold to be retuned.
- **Acceptance test**: the same four companies rank differently under the three
  fixture rubrics, and `rank(WEBSITE_SALES)[0] !== rank(ERP_REPLACEMENT)[0]`.
  Market research weights everything at zero: signals are collected and reported,
  nothing is ranked.
- **LLM stage** (`@anthropic-ai/sdk`, Haiku for per-lead work, Sonnet for
  authoring): JSON via tool use, so the API enforces the schema instead of us
  guessing at a parse. Only signals the rubric references are sent — a cost
  property and a correctness one, since a signal the user deliberately left out
  must not sway the verdict through the prompt. A malformed answer fails that one
  lead (rule-only score, `llm: null`); auth, rate limit and network errors abort
  the run, because they will hit every remaining lead too.
- **`POST /v1/rubrics/suggest`**: drafts a rubric from free text. Signal keys are
  an `enum` in the schema, and a criterion whose operator does not suit the
  signal's type is dropped. What the description asked for that no signal can
  express goes to `not_covered` rather than into an approximate proxy.
- **Calibration**: arithmetic, not an LLM call — separating two labelled sets has
  a right answer the user can check. Distinguishes a criterion that points the
  wrong way (`inverted`), one that carries no information (`no_signal`) and one
  nobody has data for (`never_measured`, i.e. the provider is the problem).
  `reliable: false` below 8 samples or when only one side was labelled.
- **Endpoints**: rubric CRUD, `POST /v1/rubrics/:id/score` → 202,
  `GET /v1/rubrics/:id/leads` (keyset on `(total, id)`),
  `PUT .../leads/:companyId/feedback`, `GET /v1/rubrics/:id/calibration`.

Migration 0003 adds `rubrics`, `lead_scores` and `scoring_runs`. Editing a rubric
bumps its version and marks existing scores `stale` rather than deleting them —
deleting would destroy the hand-labelled feedback calibration runs on.

**M4 complete** — onboarding: from a vague sentence to a runnable, shareable
search.

- **Overpass company search**: 18 company categories alongside the local-business
  vocabulary. `craft_business` maps to the bare key `craft` because the OSM value
  is the trade itself (`craft=carpenter`), and enumerating the ~70 documented
  values would go stale. Verified live for the Linz/Wels area: `office=*` 635
  objects, `craft=*` 246, `man_made=works` 462 — worth searching, thin enough
  that a company search is a seed list to enrich, not a register.
- **`GET /v1/filters/schema`**: core fields, signals and categories in one
  document. Each field carries its cost per entity (core fields are free;
  referencing a signal is what makes its provider run) and `pushed_down_by`,
  which names the adapters that can pre-filter at the source. No signal is ever
  claimed as pushed down — it exists only after its provider ran.
- **Search URLs**: readable parameters for the common shape, a base64url blob in
  `q` for anything a flat list cannot express. The round trip is the contract, so
  a bare leaf uses the opaque form rather than coming back wrapped in an AND.
  Covered by 400 generated trees.
- **Clarification**: at most four questions, chosen by what the spec is missing,
  and stateless — the client sends description plus answers, the server computes.
  No draft table, so a closed tab leaves nothing behind. Every question has a
  documented default except the category, because guessing an industry would
  silently narrow the search. "Website: egal" adds no filter, so the default
  search stays free.
- **Playbooks**: three preconfigured starting points, `POST
/v1/playbooks/:slug/start` creates search and rubric in one call.
  `sequence` is `null` until M5 — not an empty object, which would suggest
  messaging exists.

**M5 next** — outreach: channel adapters, sequences, the inbox, and the kill
switch's first real use.
