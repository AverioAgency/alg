/**
 * The human-readable API reference at GET /docs.
 *
 * Rendered from the same OpenAPI document the frontend generates its client
 * from, so the page cannot describe an endpoint that does not exist. There is no
 * second source of truth to keep in sync - adding a route to openapi.ts is what
 * makes it appear here.
 *
 * Deliberately a self-contained string rather than Swagger UI or Redoc: this API
 * runs behind Helmet, serves JSON everywhere else, and pulling a script from a
 * CDN into an authenticated origin buys a supply-chain dependency for a page
 * that has to render a list.
 */

interface Operation {
  summary?: string
  description?: string
  parameters?: {
    name: string
    in: string
    required?: boolean
    description?: string
    schema?: { type?: string; enum?: string[] }
  }[]
  requestBody?: {
    required?: boolean
    content?: Record<string, { schema?: unknown }>
  }
  responses?: Record<string, { description?: string }>
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const

/**
 * Groups routes the way someone using the API thinks about them, not the way the
 * routers happen to be split. Order matters: this is the reading order.
 */
const SECTIONS: { id: string; title: string; blurb: string; match: (path: string) => boolean }[] = [
  {
    id: "onboarding",
    title: "Onboarding",
    blurb:
      "Von einer vagen Anfrage zu einer lauffähigen Suche. Der Einstieg für ein neues Frontend: ein Playbook starten oder den Rückfrage-Dialog führen.",
    match: (p) =>
      p.startsWith("/playbooks") ||
      p.startsWith("/searches/clarify") ||
      p.startsWith("/searches/preview") ||
      p.startsWith("/searches/encode") ||
      p.startsWith("/searches/decode"),
  },
  {
    id: "filter",
    title: "Filter & Signale",
    blurb:
      "Was sich überhaupt filtern lässt, was es kostet, und was ALG über eine Firma weiß. Die Grundlage jedes Filter-Baukastens im UI.",
    match: (p) => p.startsWith("/filters") || p.startsWith("/signals") || p.endsWith("/signals"),
  },
  {
    id: "suche",
    title: "Suchen & Läufe",
    blurb: "Gespeicherte Suchen anlegen, starten und den Fortschritt verfolgen.",
    match: (p) =>
      (p.startsWith("/searches") || p.startsWith("/runs") || p.startsWith("/streams")) &&
      !p.startsWith("/searches/clarify") &&
      !p.startsWith("/searches/preview") &&
      !p.startsWith("/searches/encode") &&
      !p.startsWith("/searches/decode"),
  },
  {
    id: "daten",
    title: "Firmen & Kontakte",
    blurb: "Die gefundenen Datensätze, mit Keyset-Pagination.",
    match: (p) =>
      (p.startsWith("/companies") || p.startsWith("/contacts")) && !p.endsWith("/signals"),
  },
  {
    id: "anreicherung",
    title: "Anreicherung",
    blurb:
      "Signale erheben. Läuft nur für Provider, deren Signale irgendwo referenziert werden – ein Lauf ohne Referenz kostet nichts.",
    match: (p) => p.startsWith("/enrichments"),
  },
  {
    id: "bewertung",
    title: "Bewertung",
    blurb:
      "Rubriken, Scoring und die Lead-Liste. Eine Rubrik ist Daten: das System hat keine eingebaute Vorstellung davon, was ein guter Lead ist.",
    match: (p) => p.startsWith("/rubrics") || p.startsWith("/scoring-runs"),
  },
  {
    id: "dateien",
    title: "Dateien",
    blurb: "Berichte und Anhänge. Pfade stammen immer aus der Datenbank, nie aus der Anfrage.",
    match: (p) => p.startsWith("/files") || p.startsWith("/r/"),
  },
  {
    id: "betrieb",
    title: "Betrieb",
    blurb: "Für Monitoring und Deployment. Ohne Authentifizierung erreichbar.",
    match: (p) => p === "/health" || p === "/ready",
  },
]

const METHOD_COLOURS: Record<string, string> = {
  GET: "#2d7d46",
  POST: "#1a5fb4",
  PUT: "#9c6500",
  PATCH: "#9c6500",
  DELETE: "#a51d2d",
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Renders `backticks` as <code>, since the descriptions are written in Markdown-ish prose. */
function formatProse(value: string): string {
  return escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>")
}

function renderOperation(method: string, path: string, operation: Operation): string {
  const colour = METHOD_COLOURS[method] ?? "#555"
  const parts: string[] = []

  parts.push(`<article class="op" id="${escapeHtml(method.toLowerCase() + path)}">`)
  parts.push(
    `<h3><span class="method" style="background:${colour}">${method}</span>` +
      `<code class="path">${escapeHtml(path)}</code></h3>`
  )

  if (operation.summary) {
    parts.push(`<p class="summary">${formatProse(operation.summary)}</p>`)
  }
  if (operation.description) {
    parts.push(`<p class="desc">${formatProse(operation.description)}</p>`)
  }

  const params = operation.parameters ?? []
  if (params.length > 0) {
    parts.push(
      '<table class="params"><thead><tr><th>Parameter</th><th>In</th><th>Typ</th><th></th></tr></thead><tbody>'
    )
    for (const param of params) {
      const type = param.schema?.enum
        ? param.schema.enum.map((v) => `<code>${escapeHtml(v)}</code>`).join(" · ")
        : escapeHtml(param.schema?.type ?? "")
      parts.push(
        `<tr><td><code>${escapeHtml(param.name)}</code>${param.required ? '<span class="req">*</span>' : ""}</td>` +
          `<td>${escapeHtml(param.in)}</td><td>${type}</td>` +
          `<td>${param.description ? formatProse(param.description) : ""}</td></tr>`
      )
    }
    parts.push("</tbody></table>")
  }

  if (operation.requestBody) {
    const schema = operation.requestBody.content?.["application/json"]?.schema
    parts.push(
      `<details><summary>Request-Body${operation.requestBody.required ? " (erforderlich)" : ""}</summary>` +
        `<pre><code>${escapeHtml(JSON.stringify(schema ?? {}, null, 2))}</code></pre></details>`
    )
  }

  const responses = Object.entries(operation.responses ?? {})
  if (responses.length > 0) {
    parts.push('<ul class="responses">')
    for (const [code, response] of responses) {
      const ok = code.startsWith("2")
      parts.push(
        `<li><span class="code ${ok ? "ok" : "err"}">${escapeHtml(code)}</span> ` +
          `${escapeHtml(response.description ?? "")}</li>`
      )
    }
    parts.push("</ul>")
  }

  parts.push("</article>")
  return parts.join("\n")
}

/** The slice of the OpenAPI document this page reads. */
export interface DocsSource {
  paths?: Record<string, Partial<Record<(typeof HTTP_METHODS)[number], Operation>>>
}

export function renderDocsPage(doc: DocsSource, version: string): string {
  const entries = Object.entries(doc.paths ?? {})

  const assigned = new Set<string>()
  const sections: string[] = []
  const nav: string[] = []

  for (const section of SECTIONS) {
    const matching = entries.filter(([path]) => section.match(path) && !assigned.has(path))
    if (matching.length === 0) continue
    matching.forEach(([path]) => assigned.add(path))

    const ops: string[] = []
    let count = 0
    for (const [path, operations] of matching) {
      for (const method of HTTP_METHODS) {
        const operation = operations[method]
        if (!operation) continue
        ops.push(renderOperation(method.toUpperCase(), path, operation))
        count++
      }
    }

    nav.push(
      `<li><a href="#${section.id}">${escapeHtml(section.title)}</a> <span class="n">${count}</span></li>`
    )
    sections.push(
      `<section id="${section.id}"><h2>${escapeHtml(section.title)}</h2>` +
        `<p class="blurb">${formatProse(section.blurb)}</p>${ops.join("\n")}</section>`
    )
  }

  // A route that matched no section would silently vanish from the page, so it
  // gets its own group rather than being dropped.
  const orphans = entries.filter(([path]) => !assigned.has(path))
  if (orphans.length > 0) {
    const ops = orphans.flatMap(([path, operations]) =>
      HTTP_METHODS.filter((m) => operations[m]).map((m) =>
        renderOperation(m.toUpperCase(), path, operations[m]!)
      )
    )
    nav.push(`<li><a href="#weitere">Weitere</a> <span class="n">${ops.length}</span></li>`)
    sections.push(`<section id="weitere"><h2>Weitere</h2>${ops.join("\n")}</section>`)
  }

  const total = entries.reduce(
    (sum, [, operations]) => sum + HTTP_METHODS.filter((m) => operations[m]).length,
    0
  )

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ALG API — Referenz</title>
<style>
  :root {
    --bg: #fbfbfa; --fg: #1a1a18; --muted: #6b6b66; --line: #e4e4e0;
    --card: #fff; --accent: #1a5fb4; --code-bg: #f4f4f2;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a; --fg: #e8e8e4; --muted: #9a9a94; --line: #2c2c32;
      --card: #1d1d22; --accent: #7aa8e8; --code-bg: #232329;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 0 24px 80px; }
  header { border-bottom: 1px solid var(--line); padding: 40px 0 28px; margin-bottom: 32px; }
  h1 { margin: 0 0 8px; font-size: 30px; letter-spacing: -0.02em; }
  .sub { color: var(--muted); margin: 0 0 20px; max-width: 68ch; }
  .meta { display: flex; flex-wrap: wrap; gap: 10px; }
  .pill {
    background: var(--card); border: 1px solid var(--line); border-radius: 6px;
    padding: 5px 11px; font-size: 13px; color: var(--muted);
  }
  .pill strong { color: var(--fg); font-weight: 600; }
  .layout { display: grid; grid-template-columns: 220px 1fr; gap: 40px; align-items: start; }
  @media (max-width: 860px) { .layout { grid-template-columns: 1fr; } nav { position: static !important; } }
  nav { position: sticky; top: 24px; }
  nav ul { list-style: none; margin: 0; padding: 0; }
  nav li { margin-bottom: 3px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  nav a { color: var(--fg); text-decoration: none; font-size: 14px; padding: 4px 0; }
  nav a:hover { color: var(--accent); }
  nav .n { color: var(--muted); font-size: 12px; }
  section { margin-bottom: 52px; scroll-margin-top: 20px; }
  h2 { font-size: 21px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .blurb { color: var(--muted); margin: 0 0 20px; max-width: 72ch; font-size: 15px; }
  .op {
    background: var(--card); border: 1px solid var(--line); border-radius: 8px;
    padding: 18px 20px; margin-bottom: 14px; scroll-margin-top: 20px;
  }
  .op h3 { margin: 0 0 10px; font-size: 15px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .method {
    color: #fff; font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
    padding: 3px 8px; border-radius: 4px; min-width: 54px; text-align: center;
  }
  .path { font-size: 14px; font-weight: 600; }
  .summary { margin: 0 0 8px; }
  .desc { color: var(--muted); margin: 0 0 12px; font-size: 14.5px; max-width: 76ch; }
  code { background: var(--code-bg); padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
  .path code, h3 code { background: none; padding: 0; }
  table.params { width: 100%; border-collapse: collapse; margin: 10px 0 12px; font-size: 14px; }
  table.params th {
    text-align: left; color: var(--muted); font-weight: 500; font-size: 12px;
    text-transform: uppercase; letter-spacing: 0.05em; padding: 4px 10px 4px 0;
    border-bottom: 1px solid var(--line);
  }
  table.params td { padding: 6px 10px 6px 0; vertical-align: top; border-bottom: 1px solid var(--line); }
  .req { color: #a51d2d; margin-left: 3px; }
  details { margin: 8px 0 12px; }
  summary { cursor: pointer; color: var(--accent); font-size: 14px; }
  pre {
    background: var(--code-bg); padding: 12px 14px; border-radius: 6px;
    overflow-x: auto; font-size: 13px; margin: 8px 0 0;
  }
  pre code { background: none; padding: 0; }
  ul.responses { list-style: none; margin: 10px 0 0; padding: 0; font-size: 14px; }
  ul.responses li { margin-bottom: 3px; color: var(--muted); }
  .code { font-weight: 600; font-family: ui-monospace, monospace; margin-right: 8px; }
  .code.ok { color: #2d7d46; }
  .code.err { color: #a51d2d; }
  .note {
    background: var(--card); border: 1px solid var(--line); border-left: 3px solid var(--accent);
    border-radius: 6px; padding: 14px 18px; margin: 0 0 32px; font-size: 14.5px;
  }
  .note h4 { margin: 0 0 6px; font-size: 14px; }
  .note h4 + h5 { margin-top: 4px; }
  .note h5 {
    margin: 18px 0 6px; font-size: 13px; color: var(--fg);
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .note p { margin: 0 0 8px; color: var(--muted); }
  .note p:last-child { margin-bottom: 0; }
  .note table.params { margin: 8px 0 12px; }
  .note table.params td { color: var(--muted); }
  footer { border-top: 1px solid var(--line); margin-top: 40px; padding-top: 20px; color: var(--muted); font-size: 13px; }
  a { color: var(--accent); }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>ALG API</h1>
  <p class="sub">
    Auftrags Lead Generator. Aus einer Suchanfrage wird eine gefilterte, angereicherte
    und bewertete Lead-Liste. Diese Seite wird aus
    <a href="/v1/openapi.json">/v1/openapi.json</a> erzeugt und kann deshalb keinen
    Endpunkt beschreiben, den es nicht gibt.
  </p>
  <div class="meta">
    <span class="pill">Version <strong>${escapeHtml(version)}</strong></span>
    <span class="pill">Basis <strong>/v1</strong></span>
    <span class="pill"><strong>${total}</strong> Endpunkte</span>
    <span class="pill">OpenAPI <a href="/v1/openapi.json">JSON</a></span>
  </div>
</header>

<div class="note">
  <h4>Zwei Wege hinein</h4>
  <p>
    Beide enden bei derselben Prüfung — die Mitgliedschaft im Workspace wird bei
    jeder Anfrage kontrolliert. Ohne Authentifizierung erreichbar sind nur
    <code>/health</code>, <code>/ready</code>, <code>/docs</code> und
    <code>/r/:token</code>.
  </p>

  <h5>1. Server zu Server — für das Nexoro-Backend (PHP)</h5>
  <p>
    Nexoro authentifiziert seine Nutzer selbst. Statt für jeden einen
    Supabase-Login anzulegen, weist sich der Server mit einem gemeinsamen
    Geheimnis aus und nennt dazu, wer gerade handelt. Der Endnutzer richtet
    nichts ein.
  </p>
  <table class="params">
    <thead><tr><th>Header</th><th>Pflicht</th><th></th></tr></thead>
    <tbody>
      <tr><td><code>x-alg-service-token</code><span class="req">*</span></td><td>ja</td>
          <td>Das gemeinsame Geheimnis (<code>ALG_SERVICE_TOKEN</code>)</td></tr>
      <tr><td><code>x-workspace-slug</code></td><td>nein</td>
          <td>Mandant, falls er nicht aus der Subdomain hervorgeht</td></tr>
      <tr><td><code>x-alg-user</code></td><td>nein</td>
          <td>ID des handelnden Nutzers, damit der Audit-Log eine Person nennt</td></tr>
      <tr><td><code>x-alg-user-email</code></td><td>nein</td>
          <td>Dessen E-Mail</td></tr>
    </tbody>
  </table>
  <p>
    Der Workspace ergibt sich aus der Subdomain:
    <code>nexoro.nexoro.net</code> → <code>nexoro</code>, beim ersten Aufruf
    automatisch angelegt. Der Hostname <em>benennt</em> den Mandanten nur — das
    Geheimnis autorisiert ihn. Ohne das Token wird der Host-Header vollständig
    ignoriert, denn setzen kann ihn jeder. Reservierte Namen
    (<code>www</code>, <code>api</code>, <code>admin</code> …) und verschachtelte
    Subdomains werden abgelehnt statt zu Mandanten gemacht.
  </p>
  <p>
    <strong>Das Token gehört auf einen Server, nie in einen Browser</strong> — wer
    es hat, kann für jeden Workspace handeln.
  </p>

  <h5>2. Supabase-Token — für Aufrufe aus dem Browser</h5>
  <p>
    <code>Authorization: Bearer &lt;Supabase-Token&gt;</code> plus
    <code>x-workspace-id: &lt;uuid&gt;</code>. Dieser Weg braucht zusätzlich eine
    CORS-Freigabe (<code>ALG_CORS_ORIGINS</code>); ohne sie darf kein Browser die
    API aufrufen.
  </p>

  <h4>Konventionen</h4>
  <p>
    Fehler folgen RFC 9457 (<code>application/problem+json</code>). Der <code>type</code>-Slug
    ist stabil und Teil des öffentlichen Vertrags — darauf darf das Frontend verzweigen.
  </p>
  <p>
    Lang laufende Vorgänge antworten mit <code>202 { run_id }</code>. Paginiert wird
    ausschließlich per Cursor, nie per Offset. Jeder schreibende Endpunkt akzeptiert
    <code>Idempotency-Key</code>.
  </p>
</div>

<div class="layout">
  <nav><ul>${nav.join("\n")}</ul></nav>
  <main>${sections.join("\n")}</main>
</div>

<footer>
  Erzeugt aus dem OpenAPI-Dokument dieser Instanz. Änderungen an den Routen erscheinen
  hier automatisch — es gibt keine zweite Quelle, die gepflegt werden müsste.
</footer>
</div>
</body>
</html>`
}
