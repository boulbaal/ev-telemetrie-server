#!/usr/bin/env bash
# Maakt alle certificaten voor de telemetrie-server in één keer, zonder
# Let's Encrypt en zonder poort 80. Tesla laat toe dat we onze EIGEN CA
# meesturen in de telemetrie-configuratie ("ca"), dus een zelf gemaakt
# certificaat is voldoende, zolang de hostnaam in het certificaat klopt.
#
# Gebruik:  bash scripts/maak-certificaat.sh telemetrie.evbatterymotorservice.eu
#
# Resultaat in certs/:
#   ca.pem          -> gaat mee naar Tesla (de wagen vertrouwt deze CA)
#   fullchain.pem   -> servercertificaat (+ CA) voor fleet-telemetry
#   privkey.pem     -> serversleutel voor fleet-telemetry
#   proxy-cert.pem / proxy-key.pem -> voor de lokale vehicle-command proxy
#
# Heb je liever Let's Encrypt (bv. omdat je al certbot gebruikt): zet dan
# fullchain.pem + privkey.pem van certbot in certs/ en verwijder ca.pem.
set -euo pipefail

HOST="${1:-}"
if [ -z "$HOST" ]; then
  echo "Gebruik: bash scripts/maak-certificaat.sh <hostnaam>" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
mkdir -p certs
cd certs

if [ -f ca.pem ] && [ -f fullchain.pem ] && [ -f privkey.pem ]; then
  echo "certs/ bevat al ca.pem, fullchain.pem en privkey.pem. Verwijder ze eerst als je nieuwe wilt." >&2
  exit 1
fi

echo "1/3  Eigen CA aanmaken (10 jaar geldig)"
openssl ecparam -name prime256v1 -genkey -noout -out ca-key.pem
openssl req -x509 -new -key ca-key.pem -sha256 -days 3650 \
  -subj "/CN=EV Motor & Battery Service Telemetrie CA" -out ca.pem

echo "2/3  Servercertificaat voor $HOST (2 jaar geldig)"
openssl ecparam -name prime256v1 -genkey -noout -out privkey.pem
openssl req -new -key privkey.pem -subj "/CN=$HOST" -out server.csr
cat > server.ext <<EOF
subjectAltName = DNS:$HOST
extendedKeyUsage = serverAuth
basicConstraints = CA:FALSE
EOF
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
  -days 730 -sha256 -extfile server.ext -out server-cert.pem
cat server-cert.pem ca.pem > fullchain.pem
rm -f server.csr server.ext ca.srl server-cert.pem

echo "3/3  Certificaat voor de lokale proxy"
if [ ! -f proxy-cert.pem ]; then
  openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:secp521r1 \
    -keyout proxy-key.pem -out proxy-cert.pem -days 3650 -subj "/CN=localhost" 2>/dev/null
fi

chmod 600 ca-key.pem privkey.pem proxy-key.pem
echo
echo "Klaar. Bestanden in certs/:"
ls -1
echo
echo "Controle:"
openssl x509 -in fullchain.pem -noout -subject -dates -ext subjectAltName
echo
echo "Bewaar ca-key.pem goed; ze blijft lokaal en is nodig om later een nieuw servercertificaat te maken."
