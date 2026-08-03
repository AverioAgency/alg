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

Damit die folgenden `docker compose`-Befehle die richtige Datei finden, einmal
setzen (gilt fuer die aktuelle Shell):

```bash
cd /opt/alg
export COMPOSE_FILE=infra/docker-compose.yml
```

In Schritt 5 kommt moeglicherweise eine zweite Datei dazu.

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

| Variable                     | Wert                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `NODE_ENV`                   | `production`                                                                       |
| `DATABASE_URL`               | wird in Schritt 5 festgelegt — erst dort steht fest, ob Domain oder Container-Name |
| `SUPABASE_URL`               | `https://db-alg-nexoro.averio.agency`                                              |
| `SUPABASE_JWT_SECRET`        | das `JWT_SECRET` deiner Supabase-Instanz                                           |
| `SUPABASE_SERVICE_ROLE_KEY`  | der `SERVICE_ROLE_KEY`                                                             |
| `ALG_STORAGE_SIGNING_SECRET` | aus Schritt 3                                                                      |
| `ENCRYPTION_MASTER_KEY`      | aus Schritt 3                                                                      |
| `TRAEFIK_NETWORK`            | `edge`                                                                             |
| `TRAEFIK_ENTRYPOINT`         | aus Schritt 1                                                                      |
| `TRAEFIK_CERTRESOLVER`       | aus Schritt 1                                                                      |
| `ALG_DOMAIN`                 | `alg-nexoro.averio.agency`                                                         |

`ALG_SENDING_ENABLED` bleibt auf `false` — bis M5 gibt es keinen Versand.

Rechte einschraenken, die Datei enthaelt Zugangsdaten:

```bash
chmod 600 .env
```

---

## Schritt 5 — Datenbank erreichbar machen

Zuerst pruefen, ob Postgres ueber die Domain antwortet:

```bash
docker run --rm postgres:16-alpine \
  psql "postgresql://postgres:<PASSWORT>@db-alg-nexoro.averio.agency:5432/postgres" \
  -c "select version();"
```

**Kommt `Connection refused`, ist das kein Fehler, sondern die Regel.** Supabase
veroeffentlicht Port 5432 normalerweise nicht nach aussen, damit die Datenbank
nicht aus dem Internet erreichbar ist. Den Port zu oeffnen waere die falsche
Antwort darauf — stattdessen haengt sich ALG in dasselbe Docker-Netz.

### Variante B: ueber das interne Docker-Netz

Namen des Postgres-Containers ermitteln:

```bash
docker ps -a --filter "network=sb-alg-nexoro_default" --format "table {{.Names}}\t{{.Image}}"

# Taucht dort kein Postgres auf, liegt die DB im geteilten Stack:
docker ps -a --format "table {{.Names}}\t{{.Image}}" | grep -iE "postgres|supabase/postgres"
```

Den gefundenen Namen in die `.env` eintragen — **statt** der Domain:

```
DATABASE_URL=postgresql://postgres:<PASSWORT>@<db-container>:5432/postgres
SUPABASE_NETWORK=sb-alg-nexoro_default
```

Die Override-Datei muss bei **jedem** compose-Aufruf dabei sein. Deshalb
`COMPOSE_FILE` aus Schritt 2 erweitern:

```bash
export COMPOSE_FILE=infra/docker-compose.yml:infra/docker-compose.supabase-net.yml
```

Das gilt nur fuer die laufende Shell. Nach einem Reconnect erneut setzen — oder
dauerhaft in `/root/.bashrc` eintragen.

Verbindung aus einem Container im selben Netz testen:

```bash
docker run --rm --network sb-alg-nexoro_default postgres:16-alpine \
  psql "postgresql://postgres:<PASSWORT>@<db-container>:5432/postgres" \
  -c "select version();"
```

Jetzt sollte die Versionszeile kommen.

> Achtung beim Kopieren: `postgres:<PASSWORT>` ohne Leerzeichen nach dem
> Doppelpunkt. Ein Leerzeichen macht die Verbindungs-URL ungueltig.

---

## Schritt 6 — Images bauen

Dauert beim ersten Mal einige Minuten.

```bash
cd /opt/alg
docker compose build
```

---

## Schritt 7 — Migrationen anwenden

**Vor** dem ersten Start der API. Legt die neun Tabellen plus die Extensions
`pgcrypto` und `pg_trgm` an.

```bash
docker compose --profile tools run --rm migrate
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
docker compose up -d
docker compose ps
```

Erwartet: `api`, `worker`, `scraper`, `redis` laufen. `api` sollte nach ~20 s
`healthy` melden.

---

## Schritt 9 — Pruefen

Erst von innen, ohne Traefik:

```bash
docker compose exec api \
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

Zuerst den HTTP-Code unterscheiden - er sagt, wo es klemmt:

| Code  | Bedeutung                                                     |
| ----- | ------------------------------------------------------------- |
| `404` | Traefik erreichbar, Route unbekannt → Label- oder Netzproblem |
| `502` | Route da, Backend antwortet nicht → Container oder Port       |
| `000` | Gar keine Antwort → DNS, TLS oder Firewall, **nicht** Labels  |

Statt zu raten, die Diagnose laufen lassen:

```bash
bash infra/scripts/traefik-diagnose.sh
```

**`HTTP 000` und im Traefik-Log steht `NXDOMAIN`**

Der haeufigste Fall bei einer neuen Subdomain: Es gibt keinen A-Record, also
scheitert die ACME-HTTP-01-Challenge, es gibt kein Zertifikat, und der
TLS-Handshake bricht ab.

```
ERR Unable to obtain ACME certificate ... DNS problem: NXDOMAIN looking up A
```

Loesung: A-Record anlegen, TTL 300, bei Cloudflare **ohne Proxy** (graue Wolke) -
sonst terminiert Cloudflare TLS und die Challenge erreicht Traefik nie.

Die richtige Ziel-IP ist die einer Domain, die auf diesem Host **bereits**
funktioniert - nicht die Ausgabe von `ifconfig.me`, die hinter NAT das Gateway
zeigt:

```bash
getent hosts db-alg-nexoro.averio.agency   # dieselbe IP fuer den neuen Record
```

Danach:

```bash
getent hosts alg-nexoro.averio.agency   # muss die Server-IP liefern
docker restart traefik                  # neuer ACME-Versuch
curl -s https://alg-nexoro.averio.agency/v1/health | jq
```

**`Connection refused`, obwohl der A-Record stimmt**

Der Server liegt hinter NAT (private Adresse, z.B. `172.16.20.100`). Viele Router
kennen kein Hairpin-NAT: ein interner Host kann sich ueber die _oeffentliche_ IP
nicht selbst erreichen. Von aussen funktioniert es trotzdem.

**Deshalb immer vom eigenen Rechner testen, nicht vom Server:**

```bash
curl -v https://alg-nexoro.averio.agency/v1/health
```

Ein `Connection refused` vom Server aus ist in dieser Konstellation kein Befund.

Ob es wirklich am DNS liegt, zeigt der lokale Test - er umgeht DNS und Firewall:

```bash
curl -sk -o /dev/null -w "%{http_code}\n" \
  --resolve alg-nexoro.averio.agency:443:127.0.0.1 \
  https://alg-nexoro.averio.agency/v1/health
```

Kommt hier `200`, ist die gesamte Traefik-Konfiguration korrekt und das Problem
liegt ausserhalb des Servers.

**`EnvValidationError` beim Start**
Gewollt: eine unvollstaendige Konfiguration faellt sofort auf, statt halb zu
funktionieren. Das Log nennt jede fehlende Variable einzeln.

```bash
docker compose logs api | tail -30
```

**Migration haengt oder bricht mit `ECONNREFUSED` ab**
Die Datenbank ist unter der Domain nicht erreichbar. Schritt 5 wiederholen.

**502 von Traefik**
Die API laeuft noch nicht oder ist unhealthy:

```bash
docker compose logs api --tail 50
```

---

## Updates einspielen

```bash
cd /opt/alg
git pull
docker compose build
docker compose --profile tools run --rm migrate
docker compose up -d
```

Reihenfolge beachten: erst migrieren, dann starten.

---

## Rollback

```bash
cd /opt/alg
git checkout <letzter-guter-commit>
docker compose build
docker compose up -d
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
