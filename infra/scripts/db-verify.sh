#!/usr/bin/env bash
# Prueft, ob das Backend die Datenbank wirklich erreicht - aus dem API-Container
# heraus, mit derselben DATABASE_URL, die die Anwendung im Betrieb verwendet.
#
# Die eigentliche Pruefung liegt in packages/db/src/verify.ts und laeuft als
# kompiliertes Modul. Grund: in einem pnpm-Workspace liegen pg und drizzle-orm
# unter packages/db, nicht unter apps/api - ein `node -e` aus dem api-Verzeichnis
# findet sie nicht.
#
# Aufruf:  bash infra/scripts/db-verify.sh

set -u

printf '\n\033[1m== Readiness laut API ==\033[0m\n'
docker compose exec -T api node -e "
fetch('http://localhost:3000/v1/ready')
  .then(r => r.json())
  .then(o => console.log('  ', JSON.stringify(o.checks)))
  .catch(e => console.log('   FEHLER:', e.message))
"

printf '\n\033[1m== Schema, Extensions, Schreibzugriff, Trigram ==\033[0m'
docker compose exec -T api node /app/packages/db/dist/verify.js
