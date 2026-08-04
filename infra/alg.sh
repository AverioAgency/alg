#!/usr/bin/env bash
#
# Ein Einstiegspunkt fuer jeden compose-Aufruf auf dem Server.
#
# Warum das existiert: ALG braucht auf averiodocker zwei Compose-Dateien - die
# Basis und das Supabase-Netz-Override. Bisher wurde das ueber
# `export COMPOSE_FILE=...` geloest, das nur in der jeweiligen Shell gilt. Nach
# einem Reconnect war es weg, und ein `docker compose -f infra/docker-compose.yml
# up -d` startete die Container ohne Supabase-Netz. Der Fehler ist dann nicht
# etwa "Netzwerk fehlt", sondern:
#
#   getaddrinfo EAI_AGAIN alg-nexoro-db
#
# also HTTP 500 auf jeder Route, die die Datenbank braucht - waehrend /health
# und /docs weiter funktionieren. Das sieht nach einem Anwendungsfehler aus und
# ist keiner.
#
# Statt das zu dokumentieren, macht dieses Skript es unmoeglich: es setzt die
# Dateiliste selbst zusammen und reicht alles Weitere an docker compose durch.
#
#   ./infra/alg.sh up -d
#   ./infra/alg.sh logs -f --tail=50 api worker
#   ./infra/alg.sh build api worker
#   ./infra/alg.sh --profile tools run --rm migrate
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ ! -f .env ]]; then
  echo "alg.sh: .env fehlt im Projektwurzelverzeichnis ($PWD)." >&2
  echo "        Vorlage: cp .env.example .env  und dann ausfuellen." >&2
  exit 1
fi

read_env() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- || true; }

files=(-f infra/docker-compose.yml)

supabase_network="$(read_env SUPABASE_NETWORK)"
database_url="$(read_env DATABASE_URL)"

# Der Host aus der DATABASE_URL. Ist er weder localhost noch eine Domain,
# sondern ein blosser Container-Name, dann liegt die Datenbank in einem fremden
# Docker-Netz - und ohne das Override ist sie nicht aufloesbar.
db_host="$(printf '%s' "${database_url}" | sed -E 's#^[a-z]+://[^@]*@([^:/?]+).*#\1#')"

needs_external_network=false
case "${db_host}" in
  "" | localhost | 127.0.0.1 | postgres | *.* ) ;;
  *) needs_external_network=true ;;
esac

if [[ -z "${supabase_network}" && "${needs_external_network}" == true ]]; then
  # Der frueher hier stehende stille Rueckfall auf "kein Override" war genau
  # der Fehler, den dieses Skript verhindern soll: DATABASE_URL zeigt auf einen
  # Container-Namen, also *muss* ALG in dessen Netz - eine fehlende Zeile in der
  # .env ist ein unvollstaendiges Setup, keine lokale Entwicklung.
  echo "alg.sh: DATABASE_URL zeigt auf den Container \"${db_host}\", aber" >&2
  echo "        SUPABASE_NETWORK fehlt in der .env. Ohne diesen Eintrag starten" >&2
  echo "        die Container ohne das Netz der Datenbank und jede Route mit" >&2
  echo "        Datenbankzugriff antwortet mit HTTP 500 (getaddrinfo EAI_AGAIN)." >&2
  echo "" >&2
  echo "        Passendes Netz suchen und eintragen:" >&2
  echo "          docker network ls | grep -iE 'sb-|supabase'" >&2
  echo "          echo 'SUPABASE_NETWORK=<name>' >> /opt/alg/.env" >&2
  echo "" >&2
  echo "        Vorhandene Kandidaten:" >&2
  docker network ls --format '          {{.Name}}' | grep -iE 'sb-|supabase' >&2 ||
    echo "          (keine gefunden - laeuft die Datenbank auf diesem Host?)" >&2
  exit 1
fi

if [[ -n "${supabase_network}" ]]; then
  if ! docker network inspect "${supabase_network}" >/dev/null 2>&1; then
    # Frueh und deutlich scheitern. Ohne diese Pruefung startet der Stack
    # scheinbar sauber und faellt erst beim ersten Datenbankzugriff um.
    echo "alg.sh: SUPABASE_NETWORK=${supabase_network} existiert nicht." >&2
    echo "        Vorhandene Kandidaten:" >&2
    docker network ls --format '          {{.Name}}' | grep -iE 'sb-|supabase' >&2 ||
      echo "          (keine gefunden)" >&2
    exit 1
  fi
  files+=(-f infra/docker-compose.supabase-net.yml)
fi

exec docker compose "${files[@]}" "$@"
