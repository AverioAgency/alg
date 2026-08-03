# ALG auf averiodocker einrichten

Schritt für Schritt. Alle Befehle laufen als root auf dem Server, ausser Schritt 0.

Wichtig vorweg: Der Stack bringt **keinen eigenen Traefik** mit. Auf dem Server
laeuft bereits einer (Container `traefik`, Netz `edge`); ALG haengt sich per Labels
daran. Ein zweiter Traefik wuerde um die Ports 80/443 konkurrieren und deine
bestehenden Dienste stoeren.

---

## Schritt 0 — DNS pruefen (vom eigenen Rechner)

`alg-nexoro.averio.agency` muss auf den Server zeigen, sonst kann Let's Encrypt
kein Zertifikat ausstellen.

```bash
dig +short alg-nexoro.averio.agency
```

Erwartet: die IP von averiodocker. Kommt nichts zurueck, zuerst den A-Record
anlegen und ein paar Minuten warten.

---

## Schritt 1 — Traefik-Konfiguration auslesen

`docker inspect traefik --format '{{range .Config.Cmd}}...'` hat bei dir nur
`traefik` ausgegeben. Das heisst: Traefik wird per **Config-Datei** konfiguriert,
nicht per Kommandozeile. Die Entrypoint-Namen stehen in dieser Datei.

```bash
# Wo liegt die Config? (Mounts anzeigen)
docker inspect traefik --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'

# Config direkt aus dem Container lesen
docker exec traefik cat /etc/traefik/traefik.yml 2>/dev/null \
  || docker exec traefik cat /etc/traefik/traefik.yaml 2>/dev/null \
  || docker exec traefik cat /traefik.yml 2>/dev/null

# Falls das nichts bringt: welche Router kennt Traefik schon?
docker logs traefik 2>&1 | grep -iE "entrypoint|certificatesresolver" | head -20
```

Gesucht sind zwei Namen:

```yaml
entryPoints:
  web: # <- TRAEFIK_ENTRYPOINT waere hier "web" (Port 80)
    address: ":80"
  websecure: # <- oder "websecure" (Port 443, das ist der richtige)
    address: ":443"

certificatesResolvers:
  le: # <- TRAEFIK_CERTRESOLVER, hier "le"
    acme: ...
```

Alternativ: bei einem bereits funktionierenden Dienst abschauen, welche Labels er
verwendet — das ist der zuverlaessigste Weg.

```bash
docker inspect alg-nexoro-kong --format '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' | grep traefik
```

Notiere dir `entrypoints` und `certresolver` aus dieser Ausgabe.

---

## Schritt 2 — Repo klonen

Das Repo ist privat, ein Passwort akzeptiert GitHub seit 2021 nicht mehr. Fuer
einen Deploy-Server ist ein **Deploy Key** die bessere Wahl als ein Personal Access
Token: er gilt nur fuer dieses eine Repo und kann read-only bleiben.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/alg_deploy -N ""
cat ~/.ssh/alg_deploy.pub
```

Den ausgegebenen Key auf GitHub eintragen: Repo `alg` → Settings → Deploy keys →
Add deploy key. **"Allow write access" nicht anhaken** — der Server muss nur lesen.

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-alg
  HostName github.com
  User git
  IdentityFile ~/.ssh/alg_deploy
EOF

git clone git@github-alg:AverioAgency/alg.git /opt/alg
cd /opt/alg
```

Schneller, aber mit weiterem Zugriff: ein Fine-grained PAT mit `Contents: Read`,
begrenzt auf `AverioAgency/alg`.

```bash
mkdir -p /opt/alg && cd /opt/alg
git clone https://<TOKEN>@github.com/AverioAgency/alg.git .
```

Der Punkt am Ende klont in das aktuelle Verzeichnis statt in einen Unterordner.
Pruefen, dass es geklappt hat:

```bash
ls .env.example infra/docker-compose.yml
```

---

## Schritt 3 — Secrets erzeugen

Zwei Schluessel, die ALG selbst braucht. Ausgabe gleich kopieren:

```bash
echo "ALG_STORAGE_SIGNING_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
echo "ENCRYPTION_MASTER_KEY=$(openssl rand -base64 48 | tr -d '\n')"
```

---

## Schritt 4 — .env anlegen

```bash
cp .env.example .env
nano .env
```

Diese Werte setzen:

| Variable                     | Wert                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `NODE_ENV`                   | `production`                                                                          |
| `DATABASE_URL`               | `postgresql://postgres:<POSTGRES_PASSWORD>@db-alg-nexoro.averio.agency:5432/postgres` |
| `SUPABASE_URL`               | `https://db-alg-nexoro.averio.agency`                                                 |
| `SUPABASE_JWT_SECRET`        | das `JWT_SECRET` deiner Supabase-Instanz                                              |
| `SUPABASE_SERVICE_ROLE_KEY`  | der `SERVICE_ROLE_KEY`                                                                |
| `ALG_STORAGE_SIGNING_SECRET` | aus Schritt 3                                                                         |
| `ENCRYPTION_MASTER_KEY`      | aus Schritt 3                                                                         |
| `TRAEFIK_NETWORK`            | `edge`                                                                                |
| `TRAEFIK_ENTRYPOINT`         | aus Schritt 1                                                                         |
| `TRAEFIK_CERTRESOLVER`       | aus Schritt 1                                                                         |
| `ALG_DOMAIN`                 | `alg-nexoro.averio.agency`                                                            |

`ALG_SENDING_ENABLED` bleibt auf `false` — bis M5 gibt es keinen Versand.

Rechte einschraenken, die Datei enthaelt Zugangsdaten:

```bash
chmod 600 .env
```

---

## Schritt 5 — Datenbank erreichbar?

Bevor gebaut wird, pruefen ob Postgres ueber die Domain antwortet:

```bash
docker run --rm postgres:16-alpine \
  psql "postgresql://postgres:<PASSWORT>@db-alg-nexoro.averio.agency:5432/postgres" \
  -c "select version();"
```

Kommt eine Versionszeile: gut. Kommt `Connection refused` oder ein Timeout, ist der
Postgres-Port nicht von aussen erreichbar — dann melde dich, dann gehen wir doch
ueber das interne Docker-Netz.

---

## Schritt 6 — Images bauen

Dauert beim ersten Mal einige Minuten.

```bash
cd /opt/alg
docker compose -f infra/docker-compose.yml build
```

---

## Schritt 7 — Migrationen anwenden

**Vor** dem ersten Start der API. Legt die neun Tabellen plus die Extensions
`pgcrypto` und `pg_trgm` an.

```bash
docker compose -f infra/docker-compose.yml --profile tools run --rm migrate
```

Erwartete Ausgabe: `Migrations applied.`

Gegenpruefen:

```bash
docker run --rm postgres:16-alpine \
  psql "postgresql://postgres:<PASSWORT>@db-alg-nexoro.averio.agency:5432/postgres" \
  -c "\dt"
```

Erwartet: `workspaces`, `users`, `workspace_members`, `companies`, `contacts`,
`company_sources`, `files`, `audit_log`, `idempotency_keys`.

---

## Schritt 8 — Stack starten

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
```

Erwartet: `api`, `worker`, `scraper`, `redis` laufen. `api` sollte nach ~20 s
`healthy` melden.

---

## Schritt 9 — Pruefen

Erst von innen, ohne Traefik:

```bash
docker compose -f infra/docker-compose.yml exec api \
  node -e "fetch('http://localhost:3000/v1/health').then(r=>r.json()).then(o=>console.log(JSON.stringify(o,null,2)))"
```

Dann von aussen, ueber Traefik:

```bash
curl -s https://alg-nexoro.averio.agency/v1/health | jq
```

Erwartete Antwort:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSeconds": 12,
  "sendingEnabled": false,
  "storage": {
    "usedBytes": 0,
    "maxBytes": 53687091200,
    "usedPercent": 0,
    "overSoftLimit": false
  }
}
```

`sendingEnabled: false` ist korrekt und beabsichtigt.

Und die Readiness, die Postgres und Redis wirklich anfasst:

```bash
curl -s https://alg-nexoro.averio.agency/v1/ready | jq
# {"status":"ok","checks":{"database":"ok","redis":"ok","storage":"ok"}}
```

---

## Was jetzt laeuft — und was nicht

Erreichbar: `/v1/health`, `/v1/ready`, `/v1/openapi.json`, `/v1/files/:id`,
`/v1/r/:token`. Dazu Auth gegen Supabase, Rate-Limiting, Idempotency und der
Retention-Cron im Worker.

Noch **nicht** da: Suche, Leads, Anreicherung, Versand. Das ist M1 bis M5. Dieser
Deploy prueft die Infrastruktur, nicht die Fachlichkeit.

---

## Fehlerbilder

**`network edge declared as external, but could not be found`**
`TRAEFIK_NETWORK` stimmt nicht. `docker network ls` zeigt den echten Namen.

**Container laeuft, aber die Domain antwortet nicht**
Fast immer ein falscher `TRAEFIK_ENTRYPOINT`. Pruefen:

```bash
docker logs traefik 2>&1 | grep -i alg | tail -20
```

Sieht man dort keinen `alg-api`-Router, kennt Traefik die Labels nicht.

**`EnvValidationError` beim Start**
Gewollt: eine unvollstaendige Konfiguration faellt sofort auf, statt halb zu
funktionieren. Das Log nennt jede fehlende Variable einzeln.

```bash
docker compose -f infra/docker-compose.yml logs api | tail -30
```

**Migration haengt oder bricht mit `ECONNREFUSED` ab**
Die Datenbank ist unter der Domain nicht erreichbar. Schritt 5 wiederholen.

**502 von Traefik**
Die API laeuft noch nicht oder ist unhealthy:

```bash
docker compose -f infra/docker-compose.yml logs api --tail 50
```

---

## Updates einspielen

```bash
cd /opt/alg
git pull
docker compose -f infra/docker-compose.yml build
docker compose -f infra/docker-compose.yml --profile tools run --rm migrate
docker compose -f infra/docker-compose.yml up -d
```

Reihenfolge beachten: erst migrieren, dann starten.

---

## Rollback

```bash
cd /opt/alg
git checkout <letzter-guter-commit>
docker compose -f infra/docker-compose.yml build
docker compose -f infra/docker-compose.yml up -d
```

Migrationen werden dabei **nicht** zurueckgerollt. Sie sind vorwaertskompatibel
gebaut: aeltere Code-Versionen laufen gegen ein neueres Schema weiter.

---

## Backup einrichten

Sichert Datenbank **und** Storage-Verzeichnis. Ein `pg_dump` allein hinterlaesst
einen Katalog von Dateien, die es nicht mehr gibt.

```bash
# Storage-Volume auf dem Host finden
docker volume inspect alg_alg_storage --format '{{.Mountpoint}}'

# Taeglich um 3:30
cat >> /etc/crontab <<'EOF'
30 3 * * * root cd /opt/alg && DATABASE_URL="postgresql://postgres:<PW>@db-alg-nexoro.averio.agency:5432/postgres" ALG_STORAGE_PATH="$(docker volume inspect alg_alg_storage --format '{{.Mountpoint}}')" ./infra/scripts/backup.sh /var/backups/alg
EOF
```

Ein Backup, das nie zurueckgespielt wurde, ist eine Vermutung. Deshalb einmal
testen:

```bash
RESTORE_DATABASE_URL="postgresql://postgres:<PW>@localhost:5432/alg_restore_test" \
  ./infra/scripts/restore-test.sh /var/backups/alg/<zeitstempel>
```
