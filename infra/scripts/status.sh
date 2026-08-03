#!/usr/bin/env bash
# Zeigt an, was gerade laeuft und was dabei herauskam.
#
# Ohne Argument: Ueberblick ueber die letzten Laeufe und den Datenbestand.
# Mit Run-ID:    verfolgt genau diesen Lauf bis zum Ende.
#
# Laeuft im api-Container, weil der Server seine oeffentliche Domain wegen NAT
# nicht erreicht.
#
# Aufruf:
#   export WS=... TOKEN=...                      # aus smoke.js
#   bash infra/scripts/status.sh                 # Ueberblick
#   bash infra/scripts/status.sh <run-id>        # einen Lauf verfolgen

set -uo pipefail

: "${WS:?WS nicht gesetzt - siehe Ausgabe von smoke.js}"
: "${TOKEN:?TOKEN nicht gesetzt - siehe Ausgabe von smoke.js}"

RUN_ID="${1:-}"

hr() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

call() {
  docker compose exec -T api node -e "
    fetch('http://localhost:3000$1', {
      headers: {
        authorization: 'Bearer ${TOKEN}',
        'x-workspace-id': '${WS}',
      },
    })
      .then((r) => r.text())
      .then((t) => process.stdout.write(t))
      .catch((e) => { process.stderr.write(String(e)); process.exit(1) })
  "
}

command -v jq >/dev/null || { echo "jq fehlt (apt install jq)" >&2; exit 1; }

# --- Einen bestimmten Lauf verfolgen -----------------------------------------
if [ -n "$RUN_ID" ]; then
  hr "Lauf ${RUN_ID}"

  for i in $(seq 1 120); do
    CURRENT=$(call "/v1/enrichments/${RUN_ID}")

    if ! echo "$CURRENT" | jq -e . >/dev/null 2>&1; then
      echo "Keine gueltige Antwort:"
      echo "$CURRENT"
      exit 1
    fi

    STATUS=$(echo "$CURRENT" | jq -r '.status // "?"')
    DONE=$(echo "$CURRENT" | jq -r '.companies_done // 0')
    TOTAL=$(echo "$CURRENT" | jq -r '.companies_total // 0')
    PROVIDERS=$(echo "$CURRENT" | jq -r '.providers_run // 0')
    CACHE=$(echo "$CURRENT" | jq -r '.cache_hits // 0')

    printf '\r  [%4ds] %-10s %s/%s Firmen, %s Provider-Laeufe, %s aus Cache   ' \
      "$((i * 5))" "$STATUS" "$DONE" "$TOTAL" "$PROVIDERS" "$CACHE"

    case "$STATUS" in completed | failed | cancelled) break ;; esac
    sleep 5
  done
  echo

  echo
  call "/v1/enrichments/${RUN_ID}" | jq '{
    status, companies_total, companies_done, providers_run, cache_hits,
    referenced_keys, plan, error,
    started_at, finished_at
  }'

  # Ein Lauf, der nichts getan hat, sieht wie ein Fehler aus - ist aber oft der
  # korrekte Fall, dass kein Signal referenziert wurde.
  if [ "$(call "/v1/enrichments/${RUN_ID}" | jq -r '.providers_run')" = "0" ]; then
    printf '\n\033[33m0 Provider-Laeufe. Entweder war nichts referenziert (dann ist der\n'
    printf 'Plan leer), oder alles kam aus dem Cache. Mit force:true erzwingen.\033[0m\n'
  fi
  exit 0
fi

# --- Ueberblick ---------------------------------------------------------------
hr "Dienste"
docker compose ps --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null

hr "API"
call /v1/health | jq -c '{status, version, sendingEnabled, storage: .storage.usedPercent}'

hr "Letzte Discovery-Laeufe"
call "/v1/companies?limit=1" >/dev/null 2>&1
COMPANIES=$(call "/v1/companies?limit=200")
echo "  Firmen in der Datenbank: $(echo "$COMPANIES" | jq '.data | length')"
echo "  davon mit Domain:        $(echo "$COMPANIES" | jq '[.data[] | select(.domain)] | length')"
echo "  davon mit Telefon:       $(echo "$COMPANIES" | jq '[.data[] | select(.phone)] | length')"

hr "Letzte Enrichment-Laeufe"
call "/v1/enrichments?limit=5" | jq -r '
  .data[]
  | "  " + (.created_at | .[0:19]) + "  " + (.status | . + (" " * (10 - length)))
    + (.companies_done|tostring) + "/" + (.companies_total|tostring) + " Firmen"
    + ", " + (.providers_run|tostring) + " Provider"
    + (if .error then "  FEHLER: " + (.error.detail // .error.key) else "" end)
'

hr "Signal-Abdeckung"
# Zeigt, wie viele Firmen tatsaechlich verwertbare Signale haben - die Zahl,
# die zaehlt, wenn es an die Bewertung geht.
FIRST_IDS=$(echo "$COMPANIES" | jq -r '.data[0:10][].id')
WITH_SIGNALS=0
WITH_EMAIL=0
REACHABLE=0
for id in $FIRST_IDS; do
  SIGNALS=$(call "/v1/companies/${id}/signals")
  [ "$(echo "$SIGNALS" | jq '.values | length')" != "0" ] && WITH_SIGNALS=$((WITH_SIGNALS + 1))
  [ "$(echo "$SIGNALS" | jq -r '.values["legal.impressum.email"] // empty')" != "" ] && WITH_EMAIL=$((WITH_EMAIL + 1))
  [ "$(echo "$SIGNALS" | jq -r '.values["web.presence.reachable"] // false')" = "true" ] && REACHABLE=$((REACHABLE + 1))
done
echo "  Stichprobe der ersten 10 Firmen:"
echo "    mit Signalen:        ${WITH_SIGNALS}/10"
echo "    Website erreichbar:  ${REACHABLE}/10"
echo "    Impressum-E-Mail:    ${WITH_EMAIL}/10"

printf '\n\033[1mEinen Lauf verfolgen:\033[0m bash infra/scripts/status.sh <run-id>\n'
printf '\033[1mWorker live:\033[0m           docker compose logs -f worker\n\n'
