# EV Battery & Motor Service — telemetrieserver

Deze server ontvangt de live batterijgegevens van Tesla-wagens (Tesla Fleet
Telemetry) tijdens de **diepe analyse** van 24 uur, en stuurt ze door naar de
website. Daar worden ze geanalyseerd en getoond in het beheer.

Hij doet ook drie andere dingen: hij zet de telemetrie per wagen aan en uit,
houdt de wagen wakker tijdens de meting, en voert commando's uit die het
beheer op vraag van de klant klaarzet (wekken, laden, lichten, claxon).

```
 klant (website) ── Tesla-login + toestemming ──► website (Lovable + Supabase)
                                                     ▲          │ GET  /api/telemetrie/taken
                                                     │          ▼
 Tesla-wagen ──TLS:4433──► fleet-telemetry ──MQTT──► bridge ──► POST /api/telemetrie/metingen
                            (Tesla, docker)  mosquitto (docker)  POST /api/telemetrie/meldingen
                                                     │
                        poller (docker) ──► vehicle-command proxy (docker) ──► Tesla Fleet API
                        - telemetrie aan/uit per wagen (ondertekende configuratie)
                        - wagen bewaken en wakker houden
                        - commando's uitvoeren, meldingen en Tesla-woordenboek ophalen
```

## Inhoud

| Map / bestand | Wat |
|---|---|
| `docker-compose.yml` | De 5 onderdelen: fleet-telemetry, mosquitto, bridge, vehicle-command, poller |
| `config/` | Configuratie van fleet-telemetry en mosquitto |
| `bridge/` | MQTT → website (metingen en meldingen in batches) |
| `scripts/poller.mjs` | Website ↔ Tesla: aan/uit, wakker houden, commando's, diagnose |
| `scripts/beslis.mjs` | Pure beslislogica + **lijst met opgevraagde velden** (`VELDEN`) |
| `scripts/maak-certificaat.sh` | Maakt alle certificaten in één keer |
| `scripts/registreer-partner.mjs` | Eenmalige partnerregistratie bij Tesla |
| `scripts/status.mjs`, `zet-telemetrie-aan/af.mjs` | Handmatige controle en noodgevallen |
| `vehicle-command/` | Bouwt Tesla's officiële ondertekenings-proxy |

## Documentatie

1. **[INSTALLATIE.md](INSTALLATIE.md)** — stap voor stap de server opzetten
   (VPS of thuis, DNS, poort, certificaat, starten, controleren).
2. **[TESLA-APP.md](TESLA-APP.md)** — de Tesla-ontwikkelaarsapp, sleutels,
   partnerdomein, rechten (scopes) en wat de klant moet doen.
3. **[SITE-API.md](SITE-API.md)** — welke routes de website moet aanbieden
   (contract tussen server en website).
4. **[BEDIENING.md](BEDIENING.md)** — dagelijks gebruik, updates, problemen
   oplossen en wat we geleerd hebben.

## Snel starten (als alles al geregeld is)

```bash
cp .env.example .env            # invullen (nieuw TELEMETRIE_SECRET: openssl rand -hex 32)
mkdir -p keys && openssl ecparam -name prime256v1 -genkey -noout -out keys/private-key.pem
bash scripts/maak-certificaat.sh telemetrie.evbatterymotorservice.eu
docker compose up -d --build
docker compose ps               # 5 containers "Up"
```

## Tests

Zonder docker en zonder Tesla (Node 20+):

```bash
node --test scripts/*.test.mjs bridge/*.test.mjs
```

## Geheimen — nooit in deze repo

`.env` (TELEMETRIE_SECRET, client-ID), `certs/` (server- en CA-sleutels) en
vooral `keys/private-key.pem`: de private sleutel van de Tesla-app. Wie die
heeft, kan namens de app configuraties en commando's naar wagens sturen. De
`.gitignore` sluit ze uit. Bij de overdracht worden **alle geheimen nieuw
aangemaakt** (INSTALLATIE.md, "Nieuwe geheimen").

## Bekende verbeterpunten

- De poller zet `NODE_TLS_REJECT_UNAUTHORIZED=0` voor het hele proces, omdat
  de lokale proxy een zelfondertekend certificaat gebruikt. Beter: alleen voor
  de proxy een eigen CA vertrouwen (bv. via een undici-`Agent` of
  `NODE_EXTRA_CA_CERTS` met een proxycertificaat op naam `vehicle-command`).
- Tesla raadt sinds 2025 `fleet-auth.prd.vn.cloud.tesla.com` aan voor het
  vernieuwen van tokens (Fleet API-aankondiging 2025-07-21). De poller gebruikt
  nog `auth.tesla.com` (werkt in november 2026). Instelbaar via `TESLA_AUTH_BASE`.
- CAC (Calculated Amp-hour Capacity) zit niet in Fleet Telemetry. Aangevraagd
  bij Tesla (SUPPORT-2226, en GitHub teslamotors/fleet-telemetry#429). Zodra
  het veld bestaat: toevoegen in `VELDEN` (`scripts/beslis.mjs`).
