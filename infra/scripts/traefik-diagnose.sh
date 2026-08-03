#!/usr/bin/env bash
# Traefik-Diagnose fuer ALG. Schliesst die Ursachen von HTTP 000 der Reihe nach aus.
# Aufruf:  bash diagnose.sh

DOMAIN="${ALG_DOMAIN:-alg-nexoro.averio.agency}"

hr() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

hr "1. Zeigt der DNS-Name dorthin, wo die anderen Dienste liegen?"
# Nicht gegen ifconfig.me pruefen: hinter NAT liefert das die Gateway-Adresse,
# nicht die des Servers. Der belastbare Vergleich ist eine Domain, die auf
# diesem Host bereits funktioniert.
REFERENCE_DOMAIN="${REFERENCE_DOMAIN:-db-alg-nexoro.averio.agency}"
REF_IP=$(getent hosts "$REFERENCE_DOMAIN" | awk '{print $1}' | head -1)
DNS_IP=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)
echo "  ${DOMAIN}"
echo "    -> ${DNS_IP:-<NXDOMAIN>}"
echo "  ${REFERENCE_DOMAIN} (funktioniert bereits)"
echo "    -> ${REF_IP:-<NXDOMAIN>}"
if [ -z "$DNS_IP" ]; then
  echo "  -> BEFUND: Kein A-Record. Das allein erklaert HTTP 000."
elif [ -n "$REF_IP" ] && [ "$DNS_IP" != "$REF_IP" ]; then
  echo "  -> BEFUND: zeigt woanders hin als der funktionierende Dienst."
else
  echo "  -> ok, beide zeigen auf dieselbe Adresse"
fi

hr "2. Lauscht ueberhaupt jemand auf 443?"
ss -tlnp 2>/dev/null | grep -E ':(80|443)\s' || echo "  -> BEFUND: niemand auf 80/443!"

hr "2b. Ist der Server hinter NAT?"
echo "  lokale IPv4:"
ip -4 addr show 2>/dev/null | grep 'inet ' | grep -v '127.0.0.1' | awk '{print "    " $2}'
if [ -n "$DNS_IP" ] && ip -4 addr show 2>/dev/null | grep -q "inet ${DNS_IP}/"; then
  echo "  -> ${DNS_IP} liegt direkt auf diesem Host"
else
  echo "  -> ${DNS_IP:-die Ziel-IP} liegt NICHT auf diesem Host: NAT oder Router davor."
  echo "     Port 443 muss dort auf diesen Server weitergeleitet sein."
fi

hr "2c. Erreicht man 443 ueber die oeffentliche Adresse? (Hairpin-NAT noetig)"
if [ -n "$DNS_IP" ]; then
  echo -n "  ${DNS_IP}:443 -> "
  timeout 5 bash -c "</dev/tcp/${DNS_IP}/443" 2>/dev/null && echo "offen" \
    || echo "refused/timeout (kann auch nur fehlendes Hairpin-NAT sein - von aussen testen!)"
fi

hr "3. Antwortet Traefik lokal? (umgeht DNS und Firewall)"
echo -n "  https lokal: "
curl -sk -o /dev/null -w "%{http_code}\n" --max-time 8 \
  --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/v1/health"
echo -n "  http  lokal: "
curl -s -o /dev/null -w "%{http_code}\n" --max-time 8 \
  -H "Host: ${DOMAIN}" "http://127.0.0.1/v1/health"
echo "  (200 = alles gut; 404 = Traefik da, Route fehlt; 000 = TLS/Port-Problem)"

hr "4. Wie heissen Entrypoints und Certresolver WIRKLICH?"
echo "  --- von einem funktionierenden Dienst (kong) ---"
docker inspect alg-nexoro-kong \
  --format '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' 2>/dev/null \
  | grep -iE 'entrypoint|certresolver|rule|network' || echo "  (kong hat keine Traefik-Labels)"

echo "  --- aus der Traefik-Konfiguration ---"
docker exec traefik sh -c 'cat /etc/traefik/traefik.y*ml 2>/dev/null || cat /traefik.y*ml 2>/dev/null' \
  2>/dev/null | grep -iA3 -E 'entryPoints|certificatesResolvers' || echo "  (keine Config-Datei gefunden)"

hr "5. Hat der api-Container die richtigen Labels und Netze?"
docker inspect alg-api-1 \
  --format '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' 2>/dev/null \
  | grep traefik
echo "  Netze:"
docker inspect alg-api-1 \
  --format '{{range $n,$v := .NetworkSettings.Networks}}    {{$n}}{{println}}{{end}}' 2>/dev/null

hr "6. Kennt Traefik die ALG-Route?"
docker logs traefik 2>&1 | grep -i "alg" | tail -15 || echo "  (nichts zu alg im Log)"

hr "7. Sieht Traefik den Container im selben Netz?"
docker inspect traefik \
  --format '{{range $n,$v := .NetworkSettings.Networks}}    {{$n}}{{println}}{{end}}' 2>/dev/null

printf '\n\033[1mFERTIG.\033[0m Punkte 1-3 sagen, WO es klemmt; 4 liefert die richtigen Werte.\n'
