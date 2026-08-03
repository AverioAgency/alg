# Testabfragen

Abfragen zum Ausprobieren von Hand, nach Milestone geordnet. Der vollständige
Durchlauf steckt in `e2e-run.sh` — hier stehen die einzelnen Teile, damit man
gezielt eine Sache prüfen kann.

## Deployment

Vor dem ersten Lauf von M3/M4 auf dem Server:

```bash
cd /opt/alg

# 1. pnpm, falls es fehlt. Node 26 hat kein Corepack mehr, also aus npm:
npm i -g pnpm@10.15.0

# 2. Den richtigen Stand holen. Solange der PR nicht gemergt ist, liegt M3/M4
#    auf einem Branch - ein `git pull` auf main holt ihn NICHT.
git fetch origin
git checkout feat/m3-m4-scoring-onboarding
git pull

# 3. Neue Dependency (@anthropic-ai/sdk) und Migration 0003
pnpm install
pnpm migrate
```

### 4. Neue ENV-Variablen

**Vor** dem Neubauen in die `.env` — der Container liest sie beim Start, ein
Nachtragen danach erfordert einen weiteren Neustart.

```bash
# Geheimnis für die Anbindung des Nexoro-PHP-Backends erzeugen:
openssl rand -hex 32
```

```ini
# Dieses Geheimnis bekommt auch der PHP-Server. Leer = Service-Pfad aus.
ALG_SERVICE_TOKEN=<das erzeugte Geheimnis>

# Subdomain bestimmt den Mandanten: nexoro.nexoro.net -> Workspace "nexoro"
ALG_TENANT_DOMAIN=nexoro.net

# Nur nötig, wenn ein Browser die API direkt aufruft. Leer = kein Browser darf.
ALG_CORS_ORIGINS=

# Erst wenn die Keys da sind - ohne sie läuft alles, nur eingeschränkt:
# ohne Anthropic rein regelbasiert, ohne Google nur über Overpass.
ANTHROPIC_API_KEY=
GOOGLE_PLACES_API_KEY=
```

```bash
# 5. Images neu bauen - der laufende Container hat die neuen Endpunkte nicht
docker compose build api worker
docker compose up -d api worker

# 6. Prüfen, dass der neue Stand läuft
curl -s https://alg-nexoro.averio.agency/v1/health | jq -c '{status, version}'
```

Ein `404` auf `/v1/filters/schema` heißt fast immer: Schritt 5 fehlt.

Danach steht die Referenz aller Endpunkte unter
<https://alg-nexoro.averio.agency/docs>.

### 7. Anbindung prüfen

Ohne echtes Token muss ein `401` kommen — kommt stattdessen ein `200`, ist
etwas grundlegend falsch:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'x-alg-service-token: falsch' \
  -H 'x-workspace-slug: nexoro' \
  https://alg-nexoro.averio.agency/v1/playbooks
```

Mit dem echten Token:

```bash
curl -s -H "x-alg-service-token: $ALG_SERVICE_TOKEN" \
     -H 'x-workspace-slug: nexoro' \
     -H 'x-alg-user: test' \
     https://alg-nexoro.averio.agency/v1/playbooks | jq '.data[].slug'
```

Der erste Aufruf legt den Workspace `nexoro` an. Details zur PHP-Seite:
[FRONTEND.md](../FRONTEND.md).

## Vorbereitung

```bash
# Auf dem Server: Token holen
docker compose exec api node /app/packages/db/dist/smoke.js
export WS=...    # die ausgegebenen Zeilen
export TOKEN=...

# Von außen zusätzlich:
export ALG_URL=https://alg-nexoro.averio.agency
```

Der Server erreicht seine eigene öffentliche Domain wegen fehlendem Hairpin-NAT
nicht. Auf dem Server also **ohne** `ALG_URL` arbeiten und durch den Container
gehen; von außen mit.

Abkürzung für alles Folgende:

```bash
api() {
  local method="$1" path="$2"; shift 2
  curl -s -X "$method" "${ALG_URL:-http://localhost:3000}${path}" \
    -H "authorization: Bearer $TOKEN" \
    -H "x-workspace-id: $WS" \
    -H "content-type: application/json" "$@" | jq
}
```

---

## Der ganze Durchlauf

```bash
bash infra/scripts/e2e-run.sh                      # Website-Verkauf
PLAYBOOK=erp-replacement bash infra/scripts/e2e-run.sh
SKIP_ENRICH=1 bash infra/scripts/e2e-run.sh        # ohne Crawl, nur Regeln
```

---

## M4 — Onboarding

### Was kann der Filter überhaupt?

```bash
api GET '/v1/filters/schema?target_type=company'
```

Erwartung: 9 Core-Felder, ~29 Signale, 19 Firmenkategorien. Core-Felder kosten
`0`, Signale tragen den Preis ihres Providers. `pushed_down_by` ist bei jedem
Signal leer — ein Signal existiert erst, nachdem sein Provider lief.

### Rückfragen zu einer vagen Anfrage

```bash
api POST /v1/searches/clarify -d '{
  "description": "Handwerksbetriebe in Oberösterreich ohne moderne Website",
  "target_type": "company"
}'
```

Erwartung: höchstens vier Fragen. `runnable: false`, solange keine Region
gesetzt ist — Overpass verweigert ohne geografische Einschränkung.

Antwort mitgeben und erneut fragen:

```bash
api POST /v1/searches/clarify -d '{
  "description": "Handwerksbetriebe",
  "target_type": "company",
  "answers": [{ "question_id": "region", "value": "oberoesterreich" }]
}'
```

Erwartung: die Regionfrage kommt nicht wieder, `runnable: true`.

### Was kostet der Lauf? (vor dem Lauf)

Ohne Signalbezug — das ist die zentrale Eigenschaft des Systems:

```bash
api POST /v1/searches/preview -d '{
  "description": "Alle Firmen in OÖ",
  "target_type": "company",
  "answers": [
    { "question_id": "region", "value": "oberoesterreich" },
    { "question_id": "category", "value": ["craft_business"] }
  ]
}'
```

Erwartung: `plan.empty: true`, `cost.total_eur: 0`. Kein Provider läuft, weil
nichts eines seiner Signale referenziert.

Mit Signalbezug — derselbe Filter plus „ohne Website":

```bash
api POST /v1/searches/preview -d '{
  "description": "Handwerksbetriebe ohne Website",
  "target_type": "company",
  "answers": [
    { "question_id": "region", "value": "oberoesterreich" },
    { "question_id": "category", "value": ["craft_business"] },
    { "question_id": "website", "value": "without" }
  ]
}'
```

Erwartung: `plan.empty: false`, `web.presence` im Plan.

Eine Rubrik zählt genauso:

```bash
api POST /v1/searches/preview -d '{
  "description": "Firmen in OÖ",
  "target_type": "company",
  "answers": [{ "question_id": "region", "value": "oberoesterreich" }],
  "rubric": {
    "criteria": [{
      "label": "Keine Website",
      "signal": "web.presence.has_website",
      "condition": { "op": "eq", "value": false },
      "weight": 50, "hard": false
    }],
    "threshold": 40
  }
}'
```

Erwartung: der Plan ist nicht mehr leer, obwohl der Filter unverändert blieb.
Ein Kriterium ist eine Referenz wie jede andere.

### Suche teilen

```bash
# Kodieren
api POST /v1/searches/encode -d '{
  "spec": {
    "targetType": "company",
    "filters": { "op": "and", "children": [
      { "op": "eq", "key": "core.city", "value": "Wels" }
    ]},
    "limit": 100
  }
}'

# Zurücklesen
api POST /v1/searches/decode -d '{
  "query": "target_type=company&city=Wels&limit=100"
}'
```

Die lesbare Form für die übliche Gestalt, ein `q`-Blob für alles, was eine
flache Parameterliste nicht ausdrücken kann (OR, NOT, Signalfilter).

### Playbooks

```bash
api GET /v1/playbooks
api POST /v1/playbooks/website-sales/start -d '{"name": "Mein erster Lauf"}'
```

Erwartung: `search_id` und `rubric_id` in einem Aufruf. `sequence` ist `null` —
Sequenzen kommen mit M5.

---

## M1 — Discovery

### Firmensuche (neu in M4)

```bash
api POST /v1/searches -d '{
  "name": "Tischlereien Wels",
  "spec": {
    "targetType": "company",
    "limit": 50,
    "filters": { "op": "and", "children": [
      { "op": "eq", "key": "core.category", "value": "craft_business" },
      { "op": "within", "key": "core.geo",
        "value": { "bbox": [48.10, 13.95, 48.35, 14.40] } }
    ]}
  }
}'
```

Weitere Firmenkategorien: `company`, `industrial`, `wholesale`, `logistics`,
`it_company`, `lawyer`, `architect`, `engineer`.

**Zur Abdeckung:** OSM kartiert Firmen ungleichmäßig. Für den Raum Linz/Wels
live gemessen: `office=*` 635 Objekte, `craft=*` 246, `man_made=works` 462. Genug
zum Suchen, aber eine Firmensuche ist eine Saatliste zum Anreichern, kein
Register.

### Lokale Betriebe

```bash
api POST /v1/searches -d '{
  "name": "Restaurants Linz",
  "spec": {
    "targetType": "local_business",
    "limit": 25,
    "filters": { "op": "and", "children": [
      { "op": "eq", "key": "core.category", "value": "restaurant" },
      { "op": "within", "key": "core.geo",
        "value": { "bbox": [48.28, 14.25, 48.33, 14.33] } }
    ]}
  }
}'
```

### Lauf starten und verfolgen

```bash
api POST /v1/searches/<search-id>/run -d '{"limit": 50}'
api GET /v1/runs/<run-id>
bash infra/scripts/status.sh <run-id>
```

**Wenn 0 Firmen zurückkommen:** meist ist der öffentliche Overpass-Endpoint
überlastet und liefert eine HTML-Fehlerseite statt JSON. Der Adapter versucht es
erneut und weicht auf Mirrors aus; im Worker-Log steht, was passiert ist.

---

## M2 — Signale

```bash
# Was die Registry kann
api GET '/v1/signals/schema?target_type=company'

# Anreichern (nur was die Rubrik referenziert)
api POST /v1/enrichments -d '{"all": true, "rubric": { ... }}'

# Was ALG über eine Firma weiß, mit Herkunft
api GET /v1/companies/<company-id>/signals
```

`provenance` nennt Provider, Version und Abrufzeitpunkt. Das ist keine
Verzierung: eine Filterentscheidung muss erklärbar bleiben, und Art. 14 DSGVO
verlangt, die Quelle benennen zu können.

---

## M3 — Bewertung

### Vorlagen und eigene Rubriken

```bash
api GET /v1/rubrics/templates
api POST /v1/rubrics -d '{
  "name": "Website-Verkauf OÖ",
  "target_type": "local_business",
  "definition": { ... aus templates ... }
}'
```

Ein Kriterium auf einem Signal, das kein Provider liefert, wird beim Speichern
abgelehnt — sonst würde es nie matchen und jeder Lead schlechter scoren als
erwartet, ohne dass etwas darauf hinweist.

### Rubrik aus Freitext vorschlagen lassen

```bash
api POST /v1/rubrics/suggest -d '{
  "description": "Ich verkaufe Websites an kleine Handwerksbetriebe. Ideal sind Betriebe ohne eigene Website oder mit einer veralteten Seite, die aber telefonisch erreichbar sind. Unter 20 Mitarbeiter.",
  "target_type": "company"
}'
```

Erwartung ohne `ANTHROPIC_API_KEY`: **503** mit `type: llm-not-configured`. Das
ist kein Fehler, sondern die Aussage „unvollständig konfiguriert" — die Rubrik
lässt sich von Hand anlegen.

Mit Key: ein Entwurf plus `not_covered`. Dort steht, was sich mit den
vorhandenen Signalen **nicht** ausdrücken lässt — „unter 20 Mitarbeiter" etwa.
Ehrlicher als ein Proxy, den man für eine Messung hält.

### Bewerten

```bash
api POST /v1/rubrics/<rubric-id>/score -d '{"all": true}'
api GET /v1/scoring-runs/<run-id>
```

`llm_stage` in der Antwort: `not_used` (Rubrik hat keine LLM-Stufe), `enabled`
oder `skipped_no_key`. Alle drei sind gültige Zustände.

### Die Lead-Liste

```bash
api GET '/v1/rubrics/<rubric-id>/leads?limit=20'
api GET '/v1/rubrics/<rubric-id>/leads?qualified_only=true'
```

Jeder Lead trägt seine `breakdown`. Ein Eintrag mit `actualValue: null` heißt
**nicht gemessen** — nicht „als falsch gemessen". Ein Lead, dessen Signale alle
fehlen, sieht schlecht aus, ist aber ein Datenproblem.

`stale: true` heißt, der Score stammt aus einer älteren Rubrikversion.

### Feedback und Kalibrierung

```bash
api PUT /v1/rubrics/<rubric-id>/leads/<company-id>/feedback -d '{"feedback": "good"}'
api PUT /v1/rubrics/<rubric-id>/leads/<company-id>/feedback -d '{"feedback": "bad"}'

api GET /v1/rubrics/<rubric-id>/calibration
```

Erwartung unter 8 markierten Leads: `reliable: false`. Eine Schwelle an drei
Beispiele anzupassen ist Rauschen, kein Kalibrieren — die Zahl darf dann nicht
als Empfehlung dargestellt werden.

`suspect_criteria` unterscheidet drei Fälle:

| `reason_key`     | Bedeutung                                                    |
| ---------------- | ------------------------------------------------------------ |
| `inverted`       | Das Kriterium zeigt in die falsche Richtung                  |
| `no_signal`      | Es trägt keine Information über das Urteil                   |
| `never_measured` | Keine Daten — der Provider ist das Problem, nicht die Rubrik |

---

## Der Beweis, dass die Engine keine eingebaute Meinung hat

Dieselben Firmen unter zwei Rubriken:

```bash
api POST /v1/playbooks/website-sales/start   -d '{"name": "A"}'
api POST /v1/playbooks/erp-replacement/start -d '{"name": "B"}'
# beide bewerten, dann:
api GET '/v1/rubrics/<rubrik-A>/leads?limit=5'
api GET '/v1/rubrics/<rubrik-B>/leads?limit=5'
```

Erwartung: **unterschiedliche Reihenfolge, unterschiedliche Spitzenreiter.**
Derselbe Code, dieselben Daten, kein Sonderfall im Code. Genau das prüft auch
der Abnahmetest in `packages/core/src/scoring/__tests__/evaluate.test.ts`.

Und die Marktrecherche-Rubrik (alle Gewichte null): sie sammelt dieselben
Signale, rankt aber nichts und schließt nichts aus.
