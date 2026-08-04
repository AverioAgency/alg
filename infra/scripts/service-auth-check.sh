#!/usr/bin/env bash
# Prueft die Anbindung des PHP-Frontends und sagt, woran es liegt.
#
# Der haeufigste Fall ist kein Fehler in der Anwendung: der Container faehrt noch
# ein Image ohne den Service-Pfad, oder ALG_SERVICE_TOKEN steht zwar in der .env,
# aber der Container wurde seither nicht neu gestartet. Beides sieht von aussen
# aus wie "es passiert nichts", weil ohne das Token der Host-Header schlicht
# ignoriert wird und die Anfrage auf dem Supabase-Pfad landet.
#
# Aufruf auf dem Server:
#   bash infra/scripts/service-auth-check.sh

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

hr()   { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()   { printf '  \033[32m%s\033[0m\n' "$1"; }
warn() { printf '  \033[33m%s\033[0m\n' "$1"; }
bad()  { printf '  \033[31m%s\033[0m\n' "$1"; }

command -v jq >/dev/null || { echo "jq fehlt (apt install jq)" >&2; exit 1; }

SLUG="${SLUG:-nexoro}"
PROBLEMS=0

hr "1. Ausgecheckter Stand"
printf '  %s\n' "$(git log --oneline -1 2>/dev/null || echo 'kein git')"

hr "2. Laeuft ein Image mit dem Service-Pfad?"
# /docs kam im selben Zug wie der Service-Pfad und braucht keine Auth - damit ist
# es der billigste Test dafuer, ob das Image aktuell ist.
DOCS=$(docker compose exec -T api node -e "
  fetch('http://localhost:3000/docs')
    .then(r => console.log(r.status))
    .catch(() => console.log('000'))
" 2>/dev/null | tr -d '\r')

if [ "$DOCS" = "200" ]; then
  ok "/docs antwortet - das Image ist aktuell"
else
  bad "/docs antwortet mit ${DOCS:-nichts} - der Container faehrt einen aelteren Stand"
  warn "  docker compose build api worker && docker compose up -d api worker"
  PROBLEMS=$((PROBLEMS + 1))
fi

hr "3. Sieht der Container die neuen Variablen?"
# Bewusst nur die Laenge: der Wert gehoert nicht in ein Terminal-Log.
ENVOUT=$(docker compose exec -T api sh -c '
  printf "token_len=%s\n" "${#ALG_SERVICE_TOKEN}"
  printf "domain=%s\n" "${ALG_TENANT_DOMAIN:-}"
  printf "cors=%s\n" "${ALG_CORS_ORIGINS:-}"
' 2>/dev/null | tr -d '\r')

TOKEN_LEN=$(echo "$ENVOUT" | sed -n 's/^token_len=//p')
DOMAIN=$(echo "$ENVOUT" | sed -n 's/^domain=//p')

if [ "${TOKEN_LEN:-0}" -gt 20 ] 2>/dev/null; then
  ok "ALG_SERVICE_TOKEN ist gesetzt (${TOKEN_LEN} Zeichen)"
else
  bad "ALG_SERVICE_TOKEN fehlt im Container (${TOKEN_LEN:-0} Zeichen)"
  warn "  In die .env eintragen, dann: docker compose up -d api worker"
  warn "  Ohne das Token wird der Header ignoriert - die Anfrage laeuft auf dem"
  warn "  Supabase-Pfad und legt nichts an. Genau das sieht aus wie 'kein Fehler'."
  PROBLEMS=$((PROBLEMS + 1))
fi

if [ -n "$DOMAIN" ]; then
  ok "ALG_TENANT_DOMAIN=${DOMAIN}"
else
  warn "ALG_TENANT_DOMAIN ist leer - dann muss x-workspace-slug mitgeschickt werden"
fi

# Der Wert in der .env und der im Container koennen auseinanderlaufen, wenn die
# .env nach dem letzten Start geaendert wurde. Genau dieser Fall erzeugt das
# Bild "steht doch in der .env, tut aber nichts".
if [ -f .env ]; then
  FILE_TOKEN=$(grep -E '^ALG_SERVICE_TOKEN=' .env | head -1 | cut -d= -f2-)
  FILE_LEN=${#FILE_TOKEN}
  if [ "$FILE_LEN" -gt 20 ] && [ "${TOKEN_LEN:-0}" != "$FILE_LEN" ]; then
    bad ".env hat ${FILE_LEN} Zeichen, der Container sieht ${TOKEN_LEN:-0}"
    warn "  Der Container laeuft mit einem aelteren Environment:"
    warn "  docker compose up -d api worker"
    PROBLEMS=$((PROBLEMS + 1))
  fi
fi

hr "4. Antwortet die API auf den Service-Pfad?"
TOKEN=$(grep -E '^ALG_SERVICE_TOKEN=' .env 2>/dev/null | head -1 | cut -d= -f2-)

if [ -z "$TOKEN" ]; then
  warn "Kein Token in der .env - Schritt 4 und 5 uebersprungen"
else
  # Erst mit falschem Token: muss 401 sein. Ein 200 hier waere gravierend.
  WRONG=$(docker compose exec -T api node -e "
    fetch('http://localhost:3000/v1/playbooks', {
      headers: { 'x-alg-service-token': 'definitiv-falsch', 'x-workspace-slug': '${SLUG}' },
    }).then(r => console.log(r.status)).catch(() => console.log('000'))
  " 2>/dev/null | tr -d '\r')

  if [ "$WRONG" = "401" ]; then
    ok "falsches Token -> 401 (korrekt abgewiesen)"
  elif [ "$WRONG" = "200" ]; then
    bad "falsches Token -> 200. Der Service-Pfad prueft nichts - sofort melden."
    PROBLEMS=$((PROBLEMS + 1))
  else
    warn "falsches Token -> ${WRONG:-nichts} (erwartet 401)"
  fi

  REAL=$(docker compose exec -T api node -e "
    fetch('http://localhost:3000/v1/playbooks', {
      headers: {
        'x-alg-service-token': '${TOKEN}',
        'x-workspace-slug': '${SLUG}',
        'x-alg-user': 'check-script',
      },
    })
      .then(async r => console.log(r.status + ' ' + (await r.text()).slice(0, 200)))
      .catch(e => console.log('000 ' + e.message))
  " 2>/dev/null | tr -d '\r')

  STATUS=${REAL%% *}
  if [ "$STATUS" = "200" ]; then
    ok "echtes Token -> 200"
  else
    bad "echtes Token -> ${REAL}"
    PROBLEMS=$((PROBLEMS + 1))
  fi
fi

hr "5. Was steht in der Datenbank?"
# Ueber den api-Container, damit garantiert dieselbe DATABASE_URL gilt wie die,
# gegen die die API schreibt - in eine andere Datenbank zu schauen ist die
# zweithaeufigste Ursache fuer "da ist nichts Neues".
docker compose exec -T api node -e "
const { Client } = require('pg')
const url = process.env.DATABASE_URL ?? ''
const shown = url.replace(/:[^:@\/]*@/, ':***@')
console.log('  DATABASE_URL: ' + shown)

const client = new Client({ connectionString: url })
client.connect()
  .then(async () => {
    for (const table of ['workspaces', 'users', 'workspace_members', 'companies']) {
      const r = await client.query('select count(*)::int as n from ' + table)
      console.log('  ' + table.padEnd(20) + r.rows[0].n)
    }
    const w = await client.query(
      'select slug, created_at from workspaces order by created_at desc limit 5'
    )
    console.log('  letzte Workspaces: ' + (w.rows.map(r => r.slug).join(', ') || '(keine)'))
    await client.end()
  })
  .catch(e => console.log('  DB-Fehler: ' + e.message))
" 2>/dev/null | tr -d '\r'

hr "Ergebnis"
if [ "$PROBLEMS" -eq 0 ]; then
  ok "Keine Probleme gefunden."
  printf '\n  Sieht die Datenbank trotzdem leer aus, dann steht der Workspace unter\n'
  printf '  einem anderen Namen - oder das Datenbank-Werkzeug zeigt eine andere\n'
  printf '  Instanz als die oben genannte DATABASE_URL.\n\n'
else
  printf '\n  \033[31m%s Problem(e) gefunden - siehe oben.\033[0m\n\n' "$PROBLEMS"
fi
