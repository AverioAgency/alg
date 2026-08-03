#!/usr/bin/env bash
# Fuehrt einen kompletten Discovery-Lauf aus und prueft das Ergebnis.
#
# Nimmt die IDs aus jedem Schritt selbst mit, statt sie von Hand kopieren zu
# lassen - das Einsetzen von <id from step 1> ist die haeufigste Fehlerquelle.
#
# Laeuft standardmaessig IM api-Container gegen localhost:3000. Grund: der Server
# liegt hinter NAT und kann seine eigene oeffentliche Domain nicht erreichen
# (fehlendes Hairpin-NAT), waehrend sie von aussen einwandfrei antwortet. Ein
# Aufruf gegen ALG_URL wuerde hier also scheitern, ohne dass etwas kaputt ist.
#
# Aufruf auf dem Server:
#   docker compose exec api node /app/packages/db/dist/smoke.js   # Token holen
#   export WS=... TOKEN=...                                       # ausgegebene Zeilen
#   bash infra/scripts/smoke-run.sh
#
# Von aussen (eigener Rechner) stattdessen mit Domain:
#   export ALG_URL=https://alg-nexoro.averio.agency WS=... TOKEN=...
#   bash infra/scripts/smoke-run.sh

set -uo pipefail

: "${WS:?WS nicht gesetzt - siehe Ausgabe von smoke.js}"
: "${TOKEN:?TOKEN nicht gesetzt - siehe Ausgabe von smoke.js}"

if [ "${TOKEN}" = "eyJhbGci..." ] || [ ${#TOKEN} -lt 100 ]; then
  printf '\033[31mTOKEN sieht nach dem Platzhalter aus (%s Zeichen).\033[0m\n' "${#TOKEN}" >&2
  printf 'Den vollstaendigen Wert aus der Ausgabe von smoke.js einsetzen.\n' >&2
  exit 1
fi

# Auf dem Server ist die eigene oeffentliche Domain wegen NAT nicht erreichbar.
# Ein aus einer frueheren Sitzung uebrig gebliebenes ALG_URL wuerde den Lauf
# deshalb an einem Problem scheitern lassen, das es gar nicht gibt - also wird es
# hier ignoriert, sobald ein laufender api-Container gefunden wird.
if [ -n "${ALG_URL:-}" ] && docker compose ps --status running api 2>/dev/null | grep -q api; then
  printf '\033[33mALG_URL ist gesetzt (%s), aber der api-Container laeuft hier.\033[0m\n' "${ALG_URL}"
  printf 'Der Server erreicht seine eigene Domain wegen NAT nicht - nutze den Container.\n'
  printf '(Fuer den Weg ueber die Domain: von einem anderen Rechner ausfuehren.)\n\n'
  unset ALG_URL
fi

# Ohne ALG_URL: durch den Container, damit NAT keine Rolle spielt.
if [ -n "${ALG_URL:-}" ]; then
  MODE="direkt gegen ${ALG_URL}"
  call() {
    local method="$1" path="$2"
    shift 2
    curl -s --max-time 30 -X "$method" "${ALG_URL}${path}" \
      -H "authorization: Bearer ${TOKEN}" \
      -H "x-workspace-id: ${WS}" \
      -H "content-type: application/json" "$@"
  }
else
  MODE="im api-Container gegen localhost:3000"
  call() {
    local method="$1" path="$2" data=""
    shift 2
    # -d <json> aus den restlichen Argumenten herausziehen
    while [ $# -gt 0 ]; do
      case "$1" in
        -d) data="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    docker compose exec -T api node -e "
      const body = ${data:-null} === null ? undefined : JSON.stringify(${data:-null})
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
fi

hr() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
die() { printf '\n\033[31mFEHLGESCHLAGEN: %s\033[0m\n' "$1" >&2; exit 1; }

command -v jq >/dev/null || die "jq fehlt (apt install jq)"

printf '\033[1mModus:\033[0m %s\n' "$MODE"

hr "0. Erreichbarkeit"
HEALTH=$(call GET /v1/health)
if [ -z "$HEALTH" ] || ! echo "$HEALTH" | jq -e . >/dev/null 2>&1; then
  printf '\033[31mAPI antwortet nicht (%s).\033[0m\n' "$MODE" >&2
  if [ -n "${ALG_URL:-}" ]; then
    echo >&2
    echo "Laeuft das hier auf dem Server? Dann ALG_URL entfernen:" >&2
    echo "  unset ALG_URL && bash infra/scripts/smoke-run.sh" >&2
    echo >&2
    echo "Der Server erreicht seine eigene Domain wegen NAT nicht, von aussen geht sie." >&2
  else
    echo >&2
    echo "Container-Status:  docker compose ps api" >&2
    echo "API-Log:           docker compose logs api --tail 30" >&2
  fi
  [ -n "$HEALTH" ] && { echo >&2; echo "Antwort war: ${HEALTH}" >&2; }
  exit 1
fi
echo "$HEALTH" | jq -c '{status, version, sendingEnabled}'

hr "1. Suche anlegen"
SEARCH=$(call POST /v1/searches -d '{
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

SEARCH_ID=$(echo "$SEARCH" | jq -r '.id // empty' 2>/dev/null)
if [ -z "$SEARCH_ID" ]; then
  echo "$SEARCH" | jq . 2>/dev/null || echo "$SEARCH"
  die "keine Such-ID erhalten (Token abgelaufen? Workspace falsch?)"
fi
echo "  search_id: ${SEARCH_ID}"

hr "2. Lauf starten"
RUN=$(call POST "/v1/searches/${SEARCH_ID}/run" -d '{}')
RUN_ID=$(echo "$RUN" | jq -r '.run_id // empty' 2>/dev/null)
if [ -z "$RUN_ID" ]; then
  echo "$RUN" | jq . 2>/dev/null || echo "$RUN"
  die "keine run_id erhalten"
fi
echo "  run_id: ${RUN_ID}"

hr "3. Fortschritt (max. 120 s)"
# Overpass ist ein geteilter, kostenloser Dienst - der erste Aufruf dauert
# gelegentlich eine Weile, deshalb grosszuegig gewartet.
STATUS="?"
for i in $(seq 1 60); do
  CURRENT=$(call GET "/v1/runs/${RUN_ID}")
  STATUS=$(echo "$CURRENT" | jq -r '.status // "?"' 2>/dev/null)
  FOUND=$(echo "$CURRENT" | jq -r '.entities_found // 0' 2>/dev/null)
  printf '\r  [%3ds] status=%-10s gefunden=%s   ' "$((i * 2))" "$STATUS" "$FOUND"

  case "$STATUS" in
    completed | failed | cancelled) break ;;
  esac
  sleep 2
done
echo

hr "4. Ergebnis des Laufs"
FINAL=$(call GET "/v1/runs/${RUN_ID}")
echo "$FINAL" | jq '{status, entities_found, entities_new, entities_duplicate, cost_eur, error}'

FINAL_STATUS=$(echo "$FINAL" | jq -r '.status' 2>/dev/null)
if [ "$FINAL_STATUS" = "failed" ]; then
  echo
  echo "$FINAL" | jq '.error'
  echo
  echo "Worker-Log:  docker compose logs worker --tail 50"
  die "Lauf fehlgeschlagen"
fi

# Ein Lauf ohne Treffer sieht wie ein leeres Suchgebiet aus, ist aber meistens ein
# Adapter-Fehler: der Orchestrator faengt ihn ab, damit eine ausgefallene Quelle
# nicht die anderen mitreisst, und legt ihn im Plan ab.
FOUND_TOTAL=$(echo "$FINAL" | jq -r '.entities_found // 0' 2>/dev/null)
if [ "${FOUND_TOTAL}" = "0" ]; then
  hr "4b. Warum 0 Treffer?"
  echo "  Adapter-Ergebnisse dieses Laufs:"
  echo "$FINAL" | jq -r '
    (.plan // [])[]
    | "    " + .adapterId + ": gefunden=" + (.found|tostring)
      + (if .error then "  FEHLER: " + .error else "" end)
  ' 2>/dev/null || echo "    (kein Plan gespeichert)"

  ADAPTER_ERROR=$(echo "$FINAL" | jq -r '[(.plan // [])[] | select(.error)] | length' 2>/dev/null || echo 0)
  if [ "${ADAPTER_ERROR}" != "0" ]; then
    echo
    echo "  Ein Adapter ist gescheitert. Erreicht der Worker die Quelle ueberhaupt?"
    echo
    docker compose exec -T worker node -e "
      fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent('[out:json][timeout:25];node[\"amenity\"=\"restaurant\"](48.30,14.28,48.31,14.29);out 2;'),
      })
        .then((r) => r.text())
        .then((t) => {
          const n = (JSON.parse(t).elements || []).length
          console.log('    Overpass direkt aus dem Worker: ' + n + ' Elemente - Netzwerk ist ok.')
        })
        .catch((e) => console.log('    Overpass NICHT erreichbar: ' + e.message))
    " 2>/dev/null || echo "    (Worker-Container nicht erreichbar)"
  fi
fi

hr "5. Was in der Datenbank gelandet ist"
COMPANIES=$(call GET "/v1/companies?limit=5")
echo "$COMPANIES" \
  | jq '.data[] | {name, domain, phone, city: .address.city, postal_code: .address.postal_code}'

COUNT=$(echo "$COMPANIES" | jq '.data | length' 2>/dev/null || echo 0)
echo
echo "  angezeigt: ${COUNT} (erste Seite)"

hr "6. Provenienz einer Firma"
FIRST_ID=$(echo "$COMPANIES" | jq -r '.data[0].id // empty' 2>/dev/null)
if [ -n "$FIRST_ID" ]; then
  call GET "/v1/companies/${FIRST_ID}" \
    | jq '{name, sources: [.sources[] | {source_id, external_id}]}'
fi

if [ "$FINAL_STATUS" = "completed" ] && [ "${COUNT}" -gt 0 ]; then
  printf '\n\033[32mM1 bestaetigt: Suche -> Overpass -> normalisiert -> dedupliziert -> in der DB.\033[0m\n\n'
else
  printf '\n\033[33mLauf beendet mit status=%s, %s Firmen. Bei 0 Treffern: Bbox pruefen.\033[0m\n\n' \
    "$FINAL_STATUS" "$COUNT"
fi
