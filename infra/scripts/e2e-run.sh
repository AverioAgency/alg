#!/usr/bin/env bash
# Der komplette Durchlauf: Onboarding -> Suche -> Anreicherung -> Bewertung.
#
# Prueft M1 bis M4 an echten Daten und in der Reihenfolge, in der ein Nutzer sie
# durchlaeuft. Nimmt die IDs aus jedem Schritt selbst mit, statt sie von Hand
# kopieren zu lassen.
#
# Laeuft standardmaessig IM api-Container gegen localhost:3000, weil der Server
# seine eigene oeffentliche Domain wegen fehlendem Hairpin-NAT nicht erreicht.
#
# Aufruf auf dem Server:
#   docker compose exec api node /app/packages/db/dist/smoke.js   # Token holen
#   export WS=... TOKEN=...                                       # ausgegebene Zeilen
#   bash infra/scripts/e2e-run.sh
#
# Von aussen (eigener Rechner):
#   export ALG_URL=https://alg-nexoro.averio.agency WS=... TOKEN=...
#   bash infra/scripts/e2e-run.sh
#
# Optional:
#   PLAYBOOK=erp-replacement   # statt website-sales
#   SKIP_ENRICH=1              # nur Discovery und Regel-Bewertung, kein Crawl

set -uo pipefail

: "${WS:?WS nicht gesetzt - siehe Ausgabe von smoke.js}"
: "${TOKEN:?TOKEN nicht gesetzt - siehe Ausgabe von smoke.js}"

PLAYBOOK="${PLAYBOOK:-website-sales}"

if [ "${TOKEN}" = "eyJhbGci..." ] || [ ${#TOKEN} -lt 100 ]; then
  printf '\033[31mTOKEN sieht nach dem Platzhalter aus (%s Zeichen).\033[0m\n' "${#TOKEN}" >&2
  printf 'Den vollstaendigen Wert aus der Ausgabe von smoke.js einsetzen.\n' >&2
  exit 1
fi

if [ -n "${ALG_URL:-}" ] && docker compose ps --status running api 2>/dev/null | grep -q api; then
  printf '\033[33mALG_URL ist gesetzt, aber der api-Container laeuft hier - nutze den Container.\033[0m\n\n'
  unset ALG_URL
fi

if [ -n "${ALG_URL:-}" ]; then
  MODE="direkt gegen ${ALG_URL}"
  call() {
    local method="$1" path="$2"
    shift 2
    curl -s --max-time 60 -X "$method" "${ALG_URL}${path}" \
      -H "authorization: Bearer ${TOKEN}" \
      -H "x-workspace-id: ${WS}" \
      -H "content-type: application/json" "$@"
  }
else
  MODE="im api-Container gegen localhost:3000"
  call() {
    local method="$1" path="$2" data=""
    shift 2
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

hr()   { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
die()  { printf '\n\033[31mFEHLGESCHLAGEN: %s\033[0m\n' "$1" >&2; exit 1; }
note() { printf '\033[33m%s\033[0m\n' "$1"; }
ok()   { printf '\033[32m%s\033[0m\n' "$1"; }

command -v jq >/dev/null || die "jq fehlt (apt install jq)"

printf '\033[1mModus:\033[0m %s\n' "$MODE"
printf '\033[1mPlaybook:\033[0m %s\n' "$PLAYBOOK"

# --- 0. Erreichbarkeit --------------------------------------------------------
hr "0. Erreichbarkeit"
HEALTH=$(call GET /v1/health)
echo "$HEALTH" | jq -e . >/dev/null 2>&1 || die "API antwortet nicht: ${HEALTH:0:200}"
echo "$HEALTH" | jq -c '{status, version, sendingEnabled}'

# --- 1. Was kann der Filter? --------------------------------------------------
hr "1. Filter-Schema (M4)"
SCHEMA=$(call GET '/v1/filters/schema?target_type=company')
echo "$SCHEMA" | jq -e . >/dev/null 2>&1 || die "filters/schema antwortet nicht"

CORE=$(echo "$SCHEMA" | jq '[.fields[] | select(.kind=="core")] | length')
SIGNALS=$(echo "$SCHEMA" | jq '[.fields[] | select(.kind=="signal")] | length')
CATS=$(echo "$SCHEMA" | jq '.categories | length')
echo "  ${CORE} Core-Felder, ${SIGNALS} Signale, ${CATS} Kategorien"

# Ein Signal, das als "an der Quelle filterbar" gemeldet wird, waere gelogen -
# es existiert erst, nachdem sein Provider lief.
LIES=$(echo "$SCHEMA" | jq '[.fields[] | select(.kind=="signal" and (.pushed_down_by|length) > 0)] | length')
[ "$LIES" = "0" ] || die "${LIES} Signale behaupten, an der Quelle filterbar zu sein"
ok "  kein Signal behauptet Pushdown"

# --- 2. Rueckfragen -----------------------------------------------------------
hr "2. Rueckfragen (M4)"
CLARIFY=$(call POST /v1/searches/clarify -d '{
  "description": "Handwerksbetriebe in Oberoesterreich ohne moderne Website",
  "target_type": "company"
}')
echo "$CLARIFY" | jq -e . >/dev/null 2>&1 || die "clarify antwortet nicht"

QCOUNT=$(echo "$CLARIFY" | jq '.questions | length')
echo "  ${QCOUNT} Frage(n), runnable=$(echo "$CLARIFY" | jq -r .runnable)"
echo "$CLARIFY" | jq -r '.questions[] | "    - " + .id + " (" + .type + ", default: " + (.default_value|tostring) + ")"'
[ "$QCOUNT" -le 4 ] || die "mehr als vier Fragen (${QCOUNT})"
ok "  hoechstens vier Fragen"

# --- 3. Vorschau mit Kosten ---------------------------------------------------
hr "3. Vorschau: was kostet der Lauf? (M4)"

# 3a. Ohne Signalbezug: der Plan muss leer und der Lauf kostenlos sein. Das ist
#     die M2-Abnahmeeigenschaft, an der API sichtbar.
FREE=$(call POST /v1/searches/preview -d '{
  "description": "Alle Firmen in Oberoesterreich",
  "target_type": "company",
  "answers": [
    { "question_id": "region", "value": "oberoesterreich" },
    { "question_id": "category", "value": ["craft_business"] }
  ]
}')
FREE_EMPTY=$(echo "$FREE" | jq -r '.plan.empty')
FREE_COST=$(echo "$FREE" | jq -r '.cost.total_eur')
echo "  ohne Signalbezug: plan.empty=${FREE_EMPTY}, Kosten=${FREE_COST} EUR"
[ "$FREE_EMPTY" = "true" ] || die "Plan sollte leer sein, ist es aber nicht"
ok "  eine Suche ohne Signalbezug kostet nichts"

# 3b. Mit Signalbezug: derselbe Filter plus "ohne Website" plant den Crawler.
PAID=$(call POST /v1/searches/preview -d '{
  "description": "Handwerksbetriebe ohne Website",
  "target_type": "company",
  "answers": [
    { "question_id": "region", "value": "oberoesterreich" },
    { "question_id": "category", "value": ["craft_business"] },
    { "question_id": "website", "value": "without" }
  ]
}')
echo "  mit Signalbezug: $(echo "$PAID" | jq -r '[.plan.providers[].provider_id] | join(", ")')"
[ "$(echo "$PAID" | jq -r '.plan.empty')" = "false" ] || die "Provider haetten geplant werden muessen"
ok "  ein referenziertes Signal plant seinen Provider"

# 3c. Der Link, den man weiterschicken kann.
SHARE=$(echo "$PAID" | jq -r '.share_query')
echo "  Teilbare URL: ?${SHARE:0:90}..."
DECODED=$(call POST /v1/searches/decode -d "{\"query\": \"${SHARE}\"}")
[ "$(echo "$DECODED" | jq -r '.runnable')" = "true" ] || die "Der geteilte Link ist nicht lauffaehig"
ok "  Link laesst sich wieder einlesen"

# --- 4. Playbook starten ------------------------------------------------------
hr "4. Playbook starten (M4)"
call GET /v1/playbooks | jq -r '.data[] | "  " + .slug + "  (" + .target_type + ", " + ((.referenced_signals|length)|tostring) + " Signale)"'

START=$(call POST "/v1/playbooks/${PLAYBOOK}/start" -d "{\"name\": \"E2E ${PLAYBOOK}\"}")
SEARCH_ID=$(echo "$START" | jq -r '.search_id // empty')
RUBRIC_ID=$(echo "$START" | jq -r '.rubric_id // empty')
[ -n "$SEARCH_ID" ] || die "Playbook-Start lieferte keine search_id: ${START:0:300}"
echo "  Suche:  ${SEARCH_ID}"
echo "  Rubrik: ${RUBRIC_ID}"

# --- 5. Discovery -------------------------------------------------------------
hr "5. Discovery (M1)"
RUN=$(call POST "/v1/searches/${SEARCH_ID}/run" -d '{"limit": 40}')
RUN_ID=$(echo "$RUN" | jq -r '.run_id // empty')
[ -n "$RUN_ID" ] || die "Kein run_id: ${RUN:0:300}"
echo "  Lauf: ${RUN_ID}"

for i in $(seq 1 60); do
  STATE=$(call GET "/v1/runs/${RUN_ID}")
  STATUS=$(echo "$STATE" | jq -r '.status // "?"')
  FOUND=$(echo "$STATE" | jq -r '.entities_found // 0')
  printf '\r  [%3ds] %-10s %s gefunden   ' "$((i * 5))" "$STATUS" "$FOUND"
  case "$STATUS" in completed | failed | cancelled) break ;; esac
  sleep 5
done
echo

[ "$STATUS" = "completed" ] || die "Discovery endete mit Status ${STATUS}: $(echo "$STATE" | jq -c '.error')"
echo "$STATE" | jq -c '{entities_found, entities_new, entities_duplicate, cost_eur}'

COMPANIES=$(call GET '/v1/companies?limit=200')
TOTAL=$(echo "$COMPANIES" | jq '.data | length')
[ "$TOTAL" -gt 0 ] || die "Keine Firmen in der Datenbank - Overpass ueberlastet? (im Log nachsehen)"
ok "  ${TOTAL} Firmen"

# --- 6. Anreicherung ----------------------------------------------------------
if [ "${SKIP_ENRICH:-}" = "1" ]; then
  note "6. Anreicherung uebersprungen (SKIP_ENRICH=1)"
else
  hr "6. Anreicherung (M2)"
  RUBRIC=$(call GET "/v1/rubrics/${RUBRIC_ID}")
  ENRICH=$(call POST /v1/enrichments -d "{
    \"all\": true,
    \"rubric\": $(echo "$RUBRIC" | jq -c '.definition')
  }")
  ENRICH_ID=$(echo "$ENRICH" | jq -r '.run_id // empty')
  [ -n "$ENRICH_ID" ] || die "Keine Anreicherungs-Lauf-ID: ${ENRICH:0:300}"

  for i in $(seq 1 120); do
    ESTATE=$(call GET "/v1/enrichments/${ENRICH_ID}")
    ESTATUS=$(echo "$ESTATE" | jq -r '.status // "?"')
    printf '\r  [%4ds] %-10s %s/%s Firmen, %s Provider-Laeufe   ' \
      "$((i * 5))" "$ESTATUS" \
      "$(echo "$ESTATE" | jq -r '.companies_done // 0')" \
      "$(echo "$ESTATE" | jq -r '.companies_total // 0')" \
      "$(echo "$ESTATE" | jq -r '.providers_run // 0')"
    case "$ESTATUS" in completed | failed | cancelled) break ;; esac
    sleep 5
  done
  echo
  [ "$ESTATUS" = "completed" ] || die "Anreicherung endete mit ${ESTATUS}"
  echo "$ESTATE" | jq -c '{companies_done, providers_run, cache_hits}'
fi

# --- 7. Bewertung -------------------------------------------------------------
hr "7. Bewertung (M3)"
SCORE=$(call POST "/v1/rubrics/${RUBRIC_ID}/score" -d '{"all": true}')
SCORE_ID=$(echo "$SCORE" | jq -r '.run_id // empty')
LLM_STAGE=$(echo "$SCORE" | jq -r '.llm_stage // "?"')
[ -n "$SCORE_ID" ] || die "Keine Bewertungs-Lauf-ID: ${SCORE:0:300}"

# not_used = die Rubrik hat keine LLM-Stufe; skipped_no_key = kein API-Key
# hinterlegt, die Bewertung laeuft rein regelbasiert. Beides ist gueltig.
echo "  LLM-Stufe: ${LLM_STAGE}"
[ "$LLM_STAGE" = "skipped_no_key" ] && note "  (ANTHROPIC_API_KEY nicht gesetzt - reine Regelbewertung)"

for i in $(seq 1 120); do
  SSTATE=$(call GET "/v1/scoring-runs/${SCORE_ID}")
  SSTATUS=$(echo "$SSTATE" | jq -r '.status // "?"')
  printf '\r  [%4ds] %-10s %s/%s bewertet, %s qualifiziert   ' \
    "$((i * 5))" "$SSTATUS" \
    "$(echo "$SSTATE" | jq -r '.companies_done // 0')" \
    "$(echo "$SSTATE" | jq -r '.companies_total // 0')" \
    "$(echo "$SSTATE" | jq -r '.qualified_count // 0')"
  case "$SSTATUS" in completed | failed | cancelled) break ;; esac
  sleep 5
done
echo
[ "$SSTATUS" = "completed" ] || die "Bewertung endete mit ${SSTATUS}: $(echo "$SSTATE" | jq -c '.error')"
echo "$SSTATE" | jq -c '{companies_done, qualified_count, llm_calls, llm_tokens}'

# --- 8. Die Lead-Liste --------------------------------------------------------
hr "8. Ergebnis: die Lead-Liste"
LEADS=$(call GET "/v1/rubrics/${RUBRIC_ID}/leads?limit=10")
echo "$LEADS" | jq -r '.data[] | "  " + (.total|tostring|(" "*(3-length))+.) + "  " + (if .qualified then "JA " else "nein" end) + "  " + .company.name'

LEAD_COUNT=$(echo "$LEADS" | jq '.data | length')
[ "$LEAD_COUNT" -gt 0 ] || die "Keine bewerteten Leads"

hr "9. Warum dieser Lead? (die Aufschluesselung)"
echo "$LEADS" | jq -r '
  .data[0] as $lead
  | "  " + $lead.company.name + " - " + ($lead.total|tostring) + " Punkte (Schwelle " + ($lead.threshold|tostring) + ")",
    ($lead.breakdown[]
      | "    " + (if .matched then "+" else " " end)
      + (.points|tostring|(" "*(4-length))+.) + "  " + .label
      + (if .actualValue == null then "   [nicht gemessen]" else "" end))
'

# Ein Lead, dessen Signale alle "nicht gemessen" sind, sieht nach einem
# schlechten Lead aus, ist aber ein Datenproblem - deshalb getrennt ausweisen.
UNMEASURED=$(echo "$LEADS" | jq '[.data[0].breakdown[] | select(.actualValue == null)] | length')
MEASURED=$(echo "$LEADS" | jq '[.data[0].breakdown[] | select(.actualValue != null)] | length')
echo
echo "  gemessen: ${MEASURED}, nicht gemessen: ${UNMEASURED}"

printf '\n\033[1;32mDurchlauf komplett.\033[0m\n\n'
printf 'Weiter von Hand:\n'
printf '  Rubrik ansehen:    /v1/rubrics/%s\n' "$RUBRIC_ID"
printf '  Leads:             /v1/rubrics/%s/leads\n' "$RUBRIC_ID"
printf '  Kalibrierung:      /v1/rubrics/%s/calibration  (erst nach Feedback)\n' "$RUBRIC_ID"
printf '  Feedback geben:    PUT /v1/rubrics/%s/leads/<company-id>/feedback {"feedback":"good"}\n\n' "$RUBRIC_ID"
