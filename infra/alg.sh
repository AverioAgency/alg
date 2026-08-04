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

files=(-f infra/docker-compose.yml)

# Das Override kommt nur dazu, wenn eine Supabase-Instanz benannt ist. Lokal
# (Profil local-db) gibt es kein solches Netz, und ein `external: true` auf ein
# nicht existierendes Netz laesst compose fehlschlagen.
supabase_network="$(grep -E '^SUPABASE_NETWORK=' .env | tail -n1 | cut -d= -f2- || true)"

if [[ -n "${supabase_network}" ]]; then
  if ! docker network inspect "${supabase_network}" >/dev/null 2>&1; then
    # Frueh und deutlich scheitern. Ohne diese Pruefung startet der Stack
    # scheinbar sauber und faellt erst beim ersten Datenbankzugriff um.
    echo "alg.sh: SUPABASE_NETWORK=${supabase_network} existiert nicht." >&2
    echo "        Vorhandene Kandidaten:" >&2
    docker network ls --format '          {{.Name}}' | grep -E 'sb-|supabase' >&2 || \
      echo "          (keine gefunden)" >&2
    exit 1
  fi
  files+=(-f infra/docker-compose.supabase-net.yml)
fi

exec docker compose "${files[@]}" "$@"
