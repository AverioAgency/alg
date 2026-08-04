# Anbindung aus dem Nexoro-Frontend (PHP)

Nexoro authentifiziert seine Nutzer selbst. ALG bekommt daher keinen
Supabase-Login pro Endnutzer, sondern vertraut dem Nexoro-Server: der schickt ein
gemeinsames Geheimnis mit und sagt dazu, **wer** gerade handelt. Der Endnutzer
merkt davon nichts und muss nichts einrichten.

## Der Ablauf in einem Satz

Der Browser spricht mit Nexoro (PHP), Nexoro spricht mit ALG. Zwischen Browser
und ALG liegt nichts.

```
Browser ──(Nexoro-Session)──▶ PHP-Backend ──(Service-Token)──▶ ALG
```

Warum so herum: das Service-Token ist für den Pfad die gesamte Mandantengrenze.
Wer es hat, kann für jeden Workspace handeln. Auf einem Server ist das in
Ordnung, im Browser wäre es das Ende der Trennung.

## Einmalige Einrichtung

Auf dem ALG-Server in die `.env`:

```bash
# Geheimnis erzeugen und an beide Seiten geben
openssl rand -hex 32

ALG_SERVICE_TOKEN=<das erzeugte Geheimnis>
ALG_TENANT_DOMAIN=nexoro.net
```

Danach `docker compose up -d api worker`.

## Die Header

| Header                | Pflicht | Bedeutung                                                |
| --------------------- | ------- | -------------------------------------------------------- |
| `x-alg-service-token` | ja      | Das gemeinsame Geheimnis                                 |
| `x-alg-user`          | nein    | ID des handelnden Nexoro-Nutzers, für den Audit-Log      |
| `x-alg-user-email`    | nein    | Dessen E-Mail                                            |
| `x-workspace-slug`    | nein    | Überschreibt die aus dem Hostnamen abgeleitete Zuordnung |

**Kein** `Authorization` und **kein** `x-workspace-id` — die entfallen auf diesem
Pfad vollständig.

## Woher der Workspace kommt

Aus der Subdomain: `nexoro.nexoro.net` → Workspace `nexoro`. Taucht eine
Subdomain zum ersten Mal auf, wird der Workspace angelegt. Der Nutzer tut nichts.

Ruft dein PHP-Server ALG unter einem anderen Hostnamen auf — was der Normalfall
ist, weil die API unter `alg-nexoro.averio.agency` läuft — dann sag den Mandanten
explizit:

```php
'x-workspace-slug: ' . $mandantSlug
```

Reservierte Namen (`www`, `api`, `admin`, `auth`, `docs` und weitere) werden
abgelehnt statt zu Mandanten gemacht. Ebenso verschachtelte Subdomains:
`nexoro.evil.nexoro.net` ist **nicht** der Mandant `nexoro`.

## Minimalbeispiel

```php
<?php

function alg(string $method, string $path, ?array $body = null): array
{
    $ch = curl_init('https://alg-nexoro.averio.agency/v1' . $path);

    $headers = [
        'x-alg-service-token: ' . getenv('ALG_SERVICE_TOKEN'),
        'x-workspace-slug: '    . currentTenantSlug(),   // z.B. "nexoro"
        'x-alg-user: '          . currentUserId(),       // für den Audit-Log
        'x-alg-user-email: '    . currentUserEmail(),
        'content-type: application/json',
    ];

    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 30,
    ]);

    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }

    $response = curl_exec($ch);
    $status   = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    $decoded = json_decode($response, true) ?? [];

    // Fehler folgen RFC 9457. Der type-Slug ist stabil - darauf darf verzweigt
    // werden, auf den Text nicht.
    if ($status >= 400) {
        throw new AlgException($decoded['type'] ?? 'unknown', $decoded['detail'] ?? '', $status);
    }

    return $decoded;
}
```

Der kürzeste Weg zu einer Lead-Liste:

```php
$start = alg('POST', '/playbooks/website-sales/start', ['name' => 'Erster Lauf']);

alg('POST', "/searches/{$start['search_id']}/run", ['limit' => 200]);
// ... Lauf abwarten: GET /runs/{run_id} bis status == "completed"

alg('POST', "/rubrics/{$start['rubric_id']}/score", ['all' => true]);
// ... GET /scoring-runs/{run_id} bis status == "completed"

$leads = alg('GET', "/rubrics/{$start['rubric_id']}/leads?limit=50");
```

## Wenn der Browser doch direkt anfragen soll

Dann braucht es CORS. Standardmäßig darf **kein** Browser die API aufrufen — das
ist Absicht, weil hier Lead-Daten unter DSGVO liegen.

```bash
ALG_CORS_ORIGINS=https://nexoro.net,https://*.nexoro.net
```

Ein Platzhalter-Label ganz vorne wird unterstützt; `*` allein wird ignoriert
statt befolgt. Scheme und Port müssen exakt passen.

**Aber:** In diesem Fall braucht der Browser einen echten Supabase-Token, keinen
Service-Token. Das Service-Token darf niemals ins Frontend — dann könnte jeder
Besucher für jeden Mandanten handeln. Für den Browser-Pfad gilt weiterhin:
`Authorization: Bearer <Supabase-Token>` plus `x-workspace-id`.

## Was der Service-Pfad bewusst nicht kann

Die gespiegelten Nutzer bekommen die Rolle `member` — genug zum Suchen,
Anreichern und Bewerten, nicht genug für Aktionen, die einem unbeaufsichtigt
handelnden Dienst nicht zustehen sollten.

Die Mandantentrennung selbst ist unverändert: `withWorkspace()` erzwingt sie bei
jeder einzelnen Abfrage, unabhängig davon, welcher Pfad die Anfrage
authentifiziert hat.
