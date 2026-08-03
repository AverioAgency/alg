#!/usr/bin/env bash
# Fuehrt einen kompletten Discovery-Lauf aus und prueft das Ergebnis.
#
# Nimmt die IDs aus jedem Schritt selbst mit, statt sie von Hand kopieren zu
# lassen - das Einsetzen von <id from step 1> ist die haeufigste Fehlerquelle.
#
# Aufruf auf dem Server:
#   docker compose exec api node /app/packages/db/dist/smoke.js   # Token holen
#   export ALG_URL=... WS=... TOKEN=...                           # ausgegebene Zeilen
#   bash infra/scripts/smoke-run.sh

set -uo pipefail

: "${ALG_URL:?ALG_URL nicht gesetzt - siehe Ausgabe von smoke.js}"
: "${WS:?WS nicht gesetzt}"
: "${TOKEN:?TOKEN nicht gesetzt}"

AUTH=(-H "authorization: Bearer ${TOKEN}" -H "x-workspace-id: ${WS}")
JSON=(-H "content-type: application/json")

hr() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
die() { printf '\n\033[31mFEHLGESCHLAGEN: %s\033[0m\n' "$1" >&2; exit 1; }

command -v jq >/dev/null || die "jq fehlt (apt install jq)"

hr "0. Erreichbarkeit"
HEALTH=$(curl -s --max-time 10 "${ALG_URL}/v1/health") || die "API nicht erreichbar unter ${ALG_URL}"
echo "$HEALTH" | jq -c '{status, version, sendingEnabled}' || die "Antwort ist kein JSON: ${HEALTH}"

hr "1. Suche anlegen"
SEARCH=$(curl -s -X POST "${ALG_URL}/v1/searches" "${AUTH[@]}" "${JSON[@]}" -d '{
  "name": "Restaurants Linz (Smoke)",
  "spec": {
    "targetType": "local_business",
    "limit": 25,
    "filters": {
      "op": "and",
      "children": [
        { "op": "eq", "key": "core.category", "value": "restaurant" },
        { "op": "within", "key": "core.geo", "value": { "bbox": [48.28, 14.25, 48.33, 14.33] } }
      ]
    }
  }
}')

SEARCH_ID=$(echo "$SEARCH" | jq -r '.id // empty')
if [ -z "$SEARCH_ID" ]; then
  echo "$SEARCH" | jq . 2>/dev/null || echo "$SEARCH"
  die "keine Such-ID erhalten (Token abgelaufen? Workspace falsch?)"
fi
echo "  search_id: ${SEARCH_ID}"

hr "2. Lauf starten"
RUN=$(curl -s -X POST "${ALG_URL}/v1/searches/${SEARCH_ID}/run" "${AUTH[@]}" "${JSON[@]}" -d '{}')
RUN_ID=$(echo "$RUN" | jq -r '.run_id // empty')
if [ -z "$RUN_ID" ]; then
  echo "$RUN" | jq . 2>/dev/null || echo "$RUN"
  die "keine run_id erhalten"
fi
echo "  run_id: ${RUN_ID}"
echo "  status: $(echo "$RUN" | jq -r '.status')"

hr "3. Fortschritt (max. 120 s)"
# Overpass ist ein geteilter, kostenloser Dienst - der erste Aufruf dauert
# gelegentlich eine Weile, deshalb grosszuegig gewartet.
for i in $(seq 1 60); do
  CURRENT=$(curl -s "${ALG_URL}/v1/runs/${RUN_ID}" "${AUTH[@]}")
  STATUS=$(echo "$CURRENT" | jq -r '.status // "?"')
  FOUND=$(echo "$CURRENT" | jq -r '.entities_found // 0')
  printf '\r  [%3ds] status=%-10s gefunden=%s   ' "$((i * 2))" "$STATUS" "$FOUND"

  case "$STATUS" in
    completed|failed|cancelled) break ;;
  esac
  sleep 2
done
echo

hr "4. Ergebnis des Laufs"
FINAL=$(curl -s "${ALG_URL}/v1/runs/${RUN_ID}" "${AUTH[@]}")
echo "$FINAL" | jq '{status, entities_found, entities_new, entities_duplicate, cost_eur, error}'

FINAL_STATUS=$(echo "$FINAL" | jq -r '.status')
if [ "$FINAL_STATUS" = "failed" ]; then
  echo
  echo "Fehlerdetails:"
  echo "$FINAL" | jq '.error'
  echo
  echo "Worker-Log:  docker compose logs worker --tail 50"
  die "Lauf fehlgeschlagen"
fi

hr "5. Was in der Datenbank gelandet ist"
COMPANIES=$(curl -s "${ALG_URL}/v1/companies?limit=5" "${AUTH[@]}")
echo "$COMPANIES" | jq '.data[] | {name, domain, phone, city: .address.city, postal_code: .address.postal_code}'

COUNT=$(echo "$COMPANIES" | jq '.data | length')
echo
echo "  angezeigt: ${COUNT} (erste Seite)"

hr "6. Provenienz einer Firma"
FIRST_ID=$(echo "$COMPANIES" | jq -r '.data[0].id // empty')
if [ -n "$FIRST_ID" ]; then
  curl -s "${ALG_URL}/v1/companies/${FIRST_ID}" "${AUTH[@]}" \
    | jq '{name, sources: [.sources[] | {source_id, external_id}]}'
fi

if [ "$FINAL_STATUS" = "completed" ] && [ "${COUNT}" -gt 0 ]; then
  printf '\n\033[32mM1 bestaetigt: Suche -> Overpass -> normalisiert -> dedupliziert -> in der DB.\033[0m\n\n'
else
  printf '\n\033[33mLauf beendet mit status=%s, %s Firmen. Bei 0 Treffern: Bbox pruefen.\033[0m\n\n' \
    "$FINAL_STATUS" "$COUNT"
fi
