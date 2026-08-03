#!/usr/bin/env bash
# Prueft, ob das Backend die Datenbank wirklich erreicht - aus dem API-Container
# heraus, mit derselben DATABASE_URL, die die Anwendung im Betrieb verwendet.
#
# /v1/ready sagt nur, dass ein SELECT 1 durchgeht. Das hier prueft zusaetzlich,
# ob das Schema steht und ob geschrieben werden darf.
#
# Aufruf:  bash infra/scripts/db-verify.sh

set -u

hr() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

hr "1. Readiness laut API"
docker compose exec -T api node -e "
fetch('http://localhost:3000/v1/ready')
  .then(r => r.json())
  .then(o => console.log('  ', JSON.stringify(o.checks)))
  .catch(e => console.log('   FEHLER:', e.message))
"

hr "2. Tabellen im Schema public"
docker compose exec -T api node -e "
const { Pool } = require('pg')
const p = new Pool({ connectionString: process.env.DATABASE_URL })
p.query(\"select tablename from pg_tables where schemaname='public' order by 1\")
  .then(r => {
    console.log('   Anzahl:', r.rows.length, '(erwartet: 10 inkl. drizzle-Journal)')
    r.rows.forEach(x => console.log('    -', x.tablename))
  })
  .catch(e => console.error('   FEHLER:', e.message))
  .finally(() => p.end())
"

hr "3. Extensions"
docker compose exec -T api node -e "
const { Pool } = require('pg')
const p = new Pool({ connectionString: process.env.DATABASE_URL })
p.query(\"select extname from pg_extension where extname in ('pgcrypto','pg_trgm')\")
  .then(r => {
    const found = r.rows.map(x => x.extname)
    console.log('   gefunden:', found.join(', ') || 'KEINE')
    for (const need of ['pgcrypto', 'pg_trgm']) {
      if (!found.includes(need)) console.log('   FEHLT:', need)
    }
  })
  .catch(e => console.error('   FEHLER:', e.message))
  .finally(() => p.end())
"

hr "4. Schreibzugriff (insert + delete, hinterlaesst nichts)"
docker compose exec -T api node -e "
const { Pool } = require('pg')
const p = new Pool({ connectionString: process.env.DATABASE_URL })
;(async () => {
  try {
    const w = await p.query(
      \"insert into workspaces (name, slug) values ('__verify__', '__verify__') returning id\"
    )
    console.log('   INSERT ok:', w.rows[0].id)
    await p.query('delete from workspaces where slug = \$1', ['__verify__'])
    console.log('   DELETE ok - Lesen und Schreiben funktionieren')
  } catch (e) {
    console.error('   FEHLER:', e.message)
  } finally {
    await p.end()
  }
})()
"

hr "5. Trigram-Aehnlichkeit (Grundlage der Dedupe-Kaskade)"
docker compose exec -T api node -e "
const { Pool } = require('pg')
const p = new Pool({ connectionString: process.env.DATABASE_URL })
p.query(\"select similarity('word','two words') as s\")
  .then(r => {
    const s = Number(r.rows[0].s)
    console.log('   similarity(word, two words) =', s)
    // Muss mit der TypeScript-Implementierung uebereinstimmen, sonst wuerde
    // dasselbe Firmenpaar im Speicher zusammengefuehrt und in SQL nicht.
    console.log(Math.abs(s - 0.363636) < 0.0001
      ? '   -> stimmt mit der TS-Implementierung ueberein'
      : '   -> WEICHT AB von der TS-Implementierung!')
  })
  .catch(e => console.error('   FEHLER:', e.message))
  .finally(() => p.end())
"

printf '\n\033[1mFERTIG.\033[0m\n'
