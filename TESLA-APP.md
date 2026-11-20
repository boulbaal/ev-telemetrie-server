# Tesla-ontwikkelaarsapp, sleutels en rechten

## De app

- Portaal: https://developer.tesla.com/dashboard (account van Innovatech Belgium).
- App: **EV Battery Health Analysis**. Daar vind je het Client-ID en het
  Client-secret (Credentials).
- **Allowed Origin(s)** en **Redirect URI(s)** moeten het adres van de website
  bevatten, bv. `https://evbatterymotorservice.eu` en
  `https://evbatterymotorservice.eu/api/tesla/callback` (en hetzelfde voor de
  testkopie).
- **Scopes** van de app: `openid offline_access vehicle_device_data
  vehicle_cmds vehicle_charging_cmds vehicle_location`.
  - `vehicle_cmds` is nodig voor `wake_up` en de commando's.
  - Zonder `vehicle_cmds` werkt de meting wel, maar valt de wagen in slaap en
    stopt de stroom gegevens.

## Sleutelpaar

De app heeft één EC-sleutelpaar (prime256v1):

- **private** → `keys/private-key.pem` op deze server. Daarmee ondertekent de
  proxy de telemetrieconfiguratie en de commando's.
- **publiek** → op de website op
  `https://evbatterymotorservice.eu/.well-known/appspecific/com.tesla.3p.public-key.pem`.
  Moet daar **altijd** bereikbaar blijven; anders werkt het koppelen niet meer
  (Tesla-aankondiging 2024-02-02).

Een nieuw paar maken (enkel als er nog geen is, of bij een lek):

```bash
openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem
openssl ec -in private-key.pem -pubout -out public-key.pem
```

Na een nieuw paar moet elke klant de sleutel opnieuw toevoegen.

## Partnerdomein (eenmalig, al gebeurd voor evbatterymotorservice.eu)

Tesla moet het domein kennen waarop de publieke sleutel staat. De hostnaam van
de telemetrieserver moet onder dat domein vallen.

```bash
TESLA_CLIENT_ID=... TESLA_CLIENT_SECRET=... TESLA_DOMAIN=evbatterymotorservice.eu \
  TESLA_SCOPES="openid offline_access vehicle_device_data" \
  node scripts/registreer-partner.mjs
```

Verwacht antwoord: `200` met `account_id` en `domain`. Opnieuw doen is enkel
nodig bij een ander domein of een nieuw sleutelpaar.

## Welke wagens kunnen meedoen

| Wagen | Telemetrie? | Wat de klant doet |
|---|---|---|
| Model 3, Model Y, Cybertruck, Model S/X vanaf 2021 | ja (firmware ≥ 2024.26) | virtuele sleutel toevoegen via `https://www.tesla.com/_ak/evbatterymotorservice.eu` (opent de Tesla-app) |
| Model S/X van vóór 2021 met Intel Atom-computer (MCU2) | ja, firmware ≥ 2025.20 | **geen sleutel**: in de wagen Bediening → Veiligheid → "Gegevensstreaming van apps van derden toestaan" aanzetten |
| Model S/X met oude MCU1 (meestal vóór maart 2018, niet opgewaardeerd) | nee (`unsupported_hardware`) | enkel basisrapport, of meting in de garage |

`fleet_status` (de website vraagt dat op) geeft `fleet_telemetry_version`,
`firmware_version` en `safety_screen_streaming_toggle_enabled`.

## Wat de klant doet (diepe analyse)

1. Op de website: aanvraag "Diepe analyse", betalen, inloggen bij Tesla en
   **alle rechten aanvinken**.
2. De virtuele sleutel toevoegen, of bij een oudere S/X de schakelaar aanzetten.
   Daarna klikt de klant "Sleutel toegevoegd".
3. De poller ziet de status `sleutel_toegevoegd`, zet de telemetrie aan en zet
   het dossier op `actief`. Na 24 u zet hij ze weer uit (`klaar`).

**Valkuil:** heeft een klant vroeger al toestemming gegeven met minder rechten,
dan blijft Tesla die oude toestemming gebruiken bij een nieuwe login. Oplossing:
de klant trekt de toegang in op https://www.tesla.com/teslaaccount (Apps van
derden beheren), en logt daarna opnieuw in.

## Velden en meldingen

- De opgevraagde velden staan in `scripts/beslis.mjs` (`VELDEN`).
- Velden die pas vanaf firmware 2026.32 bestaan (`NominalFullPackEnergyKwh`,
  `BrickSocMinPercent`) worden enkel gevraagd als de wagen die firmware heeft.
- Meldingen (alerts): `alert_types: ["service","service-fix","customer"]` in de
  configuratie. Zonder `alert_types` stuurt Tesla geen enkele melding.
- Volledige veldenlijst: https://developer.tesla.com/docs/fleet-api/fleet-telemetry/available-data
  en https://github.com/teslamotors/fleet-telemetry/blob/main/protos/vehicle_data.proto
- Woordenboek van meldingen (de poller laadt het dagelijks):
  https://fleet-api-files-prd.tesla.com/alert_dictionary.csv

## Kosten

Fleet API is betalend per gebruik (sinds 2025). Telemetrie is goedkoop, maar
`wake_up` en `vehicle_data` kosten meer. Stel een betaallimiet in via
developer.tesla.com → Facturering.
