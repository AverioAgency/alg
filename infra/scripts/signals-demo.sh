#!/usr/bin/env bash
# Zeigt das Kernverhalten des Signal-Layers an der laufenden Instanz:
# ohne Signal-Referenz laeuft nichts, mit Referenz entsteht ein Plan.
#
# Laeuft wie smoke-run.sh im api-Container, weil der Server seine eigene
# oeffentliche Domain wegen NAT nicht erreicht.
#
# Aufruf:
#   docker compose exec api node /app/packages/db/dist/smoke.js   # Token holen
#   export WS=... TOKEN=...
#   bash infra/scripts/signals-demo.sh

set -uo pipefail

: "${WS:?WS nicht gesetzt - siehe Ausgabe von smoke.js}"
: "${TOKEN:?TOKEN nicht gesetzt - siehe Ausgabe von smoke.js}"

if [ ${#TOKEN} -lt 100 ]; then
  printf '\033[31mTOKEN sieht nach einem Platzhalter aus (%s Zeichen).\033[0m\n' "${#TOKEN}" >&2
  exit 1
fi

hr() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
die() { printf '\n\033[31mFEHLGESCHLAGEN: %s\033[0m\n' "$1" >&2; exit 1; }

command -v jq >/dev/null || die "jq fehlt (apt install jq)"

# Ruft die API im Container auf. ALG_URL wird bewusst ignoriert.
call() {
  local method="$1" path="$2" data="${3:-null}"
  docker compose exec -T api node -e "
    const body = ${data} === null ? undefined : JSON.stringify(${data})
    fetch('http://localhost:3000${path}', {
      method: '${method}',
      headers: {
        authorization: 'Bearer ${TOKEN}',
        'x-workspace-id': '${WS}',
        'content-type': 'application/json',
      },
      ...(body ? { body } : {}),
    })
      .then((r) => r.text())
      .then((t) => process.stdout.write(t))
      .catch((e) => { process.stderr.write(String(e)); process.exit(1) })
  "
}

hr "0. Erreichbarkeit"
HEALTH=$(call GET /v1/health)
echo "$HEALTH" | jq -e . >/dev/null 2>&1 || die "API antwortet nicht. Log: docker compose logs api --tail 30"
echo "$HEALTH" | jq -c '{status, version}'

hr "1. Welche Signale kennt die Registry?"
call GET "/v1/signals/schema?target_type=local_business" \
  | jq '{providers: [.providers[] | {id, depends_on: .dependsOn, ttl: .ttlDays}]}'

hr "2. Suche OHNE Signal-Referenz"
echo "   Erwartung: leerer Plan, 0 EUR - kein Provider laeuft."
NOTHING=$(call POST /v1/signals/preview '{
  "spec": {
    "targetType": "local_business",
    "filters": { "op": "eq", "key": "core.city", "value": "Linz" }
  },
  "entities": 25
}')
echo "$NOTHING" | jq '{empty, providers: [.providers[].provider_id], total_eur: .cost.total_eur, core_keys}'

if [ "$(echo "$NOTHING" | jq -r '.empty')" != "true" ]; then
  die "Plan haette leer sein muessen - das ist die zentrale M2-Eigenschaft"
fi

hr "3. Dieselbe Suche MIT Signal-Referenz"
echo "   Erwartung: web.presence kommt als Abhaengigkeit mit."
WITH=$(call POST /v1/signals/preview '{
  "spec": {
    "targetType": "local_business",
    "filters": { "op": "exists", "key": "legal.impressum.email", "value": true }
  },
  "entities": 25
}')
echo "$WITH" | jq '{
  providers: [.providers[] | {provider_id, depends_on}],
  transitive,
  total_eur: .cost.total_eur
}'

hr "4. Rubrik mit Gewicht 0 zieht trotzdem den Provider"
echo "   Der Nutzer will die Spalte sehen, auch wenn sie nicht rankt."
call POST /v1/signals/preview '{
  "spec": { "targetType": "local_business", "filters": { "op": "and", "children": [] } },
  "rubric": {
    "criteria": [{
      "label": "Hat Website",
      "signal": "web.presence.has_website",
      "condition": { "op": "eq", "value": true },
      "weight": 0,
      "hard": false
    }],
    "threshold": 0
  },
  "entities": 25
}' | jq '{providers: [.providers[].provider_id], from_rubric: .references.from_rubric}'

hr "5. Anreicherung der vorhandenen Firmen starten"
RUN=$(call POST /v1/enrichments '{
  "all": true,
  "spec": {
    "targetType": "local_business",
    "filters": { "op": "exists", "key": "legal.impressum.email", "value": true }
  }
}')
RUN_ID=$(echo "$RUN" | jq -r '.run_id // empty')
if [ -z "$RUN_ID" ]; then
  echo "$RUN" | jq . 2>/dev/null || echo "$RUN"
  die "kein run_id erhalten"
fi
echo "  run_id: ${RUN_ID}, Firmen: $(echo "$RUN" | jq -r '.companies')"

hr "6. Fortschritt (max. 300 s)"
# Echte Websites, ein Request pro Host mit Wartezeit - das dauert.
for i in $(seq 1 60); do
  CURRENT=$(call GET "/v1/enrichments/${RUN_ID}")
  STATUS=$(echo "$CURRENT" | jq -r '.status // "?"')
  DONE=$(echo "$CURRENT" | jq -r '.companies_done // 0')
  TOTAL=$(echo "$CURRENT" | jq -r '.companies_total // 0')
  printf '\r  [%3ds] status=%-10s %s/%s Firmen   ' "$((i * 5))" "$STATUS" "$DONE" "$TOTAL"
  case "$STATUS" in completed | failed | cancelled) break ;; esac
  sleep 5
done
echo

hr "7. Ergebnis"
FINAL=$(call GET "/v1/enrichments/${RUN_ID}")
echo "$FINAL" | jq '{status, companies_done, providers_run, cache_hits, error}'

hr "8. Signale einer Firma, mit Provenienz"
FIRST=$(call GET "/v1/companies?limit=1" | jq -r '.data[0].id // empty')
if [ -n "$FIRST" ]; then
  call GET "/v1/companies/${FIRST}/signals" | jq '{
    values,
    provenance: [.provenance[] | {providerId, fetchedAt, stale, error}]
  }'
else
  echo "  (keine Firmen in der Datenbank - erst bash infra/scripts/smoke-run.sh)"
fi

printf '\n\033[1mFERTIG.\033[0m Punkt 2 vs. 3 zeigt die zentrale Eigenschaft: ohne Referenz laeuft nichts.\n\n'
