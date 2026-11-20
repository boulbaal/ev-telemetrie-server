# Contract tussen de server en de website

Alle routes vragen de kop `Authorization: Bearer <TELEMETRIE_SECRET>`, en
sturen en ontvangen JSON. Bij een fout geeft de website `401` (verkeerd
geheim), `400` (ongeldige inhoud) of `404` (route bestaat niet). De server
verdraagt een 404 op de nieuwere routes (`wagen`, `meldingen`,
`woordenboek`): hij probeert het dan 10 minuten later opnieuw.

## GET /api/telemetrie/taken

Wat de server moet doen. Wordt elke minuut opgevraagd.

```json
{
  "taken": [{
    "aanvraag_id": "uuid", "vin": "5YJ…", "naam": "…", "locale": "nl",
    "telemetrie_status": "sleutel_toegevoegd | actief",
    "tesla_access_token": "…", "tesla_refresh_token": "…",
    "telemetrie_tot": "ISO | null", "gestart_op": "ISO | null",
    "laatste_soc": 54.2, "firmware": "2026.20.6"
  }],
  "instellingen": {
    "telemetrie_host": "telemetrie.evbatterymotorservice.eu", "telemetrie_poort": 4433,
    "telemetrie_uren": 24, "tesla_sleutel_domein": "evbatterymotorservice.eu",
    "telemetrie_wakker_houden": true
  },
  "commandos": [{ "id": "uuid", "aanvraag_id": "uuid", "vin": "5YJ…", "commando": "knipperen", "params": null }]
}
```

Statussen van de telemetrie: `wacht_sleutel` → (klant klikt "Sleutel
toegevoegd") `sleutel_toegevoegd` → `actief` → `klaar`, of `fout`.

Commando's: `wake_up`, `laden_starten`, `laden_stoppen`,
`laadlimiet` (`params.percent` 50–100), `klimaat_aan`, `klimaat_uit`,
`knipperen`, `claxon`, en `verbinding_feedback` (knipperen + claxon).

## POST /api/telemetrie/status

`{ "aanvraag_id", "status": "actief|klaar|fout|…", "detail"?, "tesla_access_token"?, "tesla_refresh_token"? }`

Bij `actief` zet de website het meetvenster (`telemetrie_tot` = nu + `telemetrie_uren`).

## POST /api/telemetrie/metingen

`{ "metingen": [{ "vin", "signaal", "waarde": number|string|boolean, "gemeten_op": "ISO" }] }`
(max 500). De website koppelt elke meting aan de nieuwste actieve diepe aanvraag
met die VIN, en geeft `{ ok, ingevoegd, genegeerd }` terug.

## POST /api/telemetrie/meldingen

`{ "meldingen": [{ "vin", "naam", "soort": "alert|telemetriefout", "bron": "telemetrie|recent_alerts|fleet_telemetry_errors", "gestart_op"?, "beeindigd_op"?, "doelgroepen"?: string[], "detail"?: object, "aanvraag_id"? }] }`
(max 200). Velden die niet bekend zijn, worden **weggelaten** (niet `null`
sturen voor optionele tekst/lijsten). Antwoord `{ ok, ingevoegd, genegeerd }`.

## POST /api/telemetrie/woordenboek

`{ "items": [{ "naam", "beschrijving"?, "voorwaarde"?, "einde"?, "gevolg"?, "klanttekst"?, "doelgroepen"?, "modellen"? }] }`
(max 200 per oproep). De uitleg van Tesla per melding (BMS, DI, HVP, PCS, CP, …).

## POST /api/telemetrie/wagen

`{ "aanvraag_id", "vin", "wagen_status": "online|asleep|offline", "gewekt": bool }`

## POST /api/telemetrie/commando

`{ "id", "status": "ok|fout", "resultaat" }` — het resultaat van een
commando uit `taken.commandos`.

## POST /api/telemetrie/log

`{ "niveau": "info|warn|error", "detail", "aanvraag_id"? }` — een logregel
voor het beheer.

## Database (Supabase) — tabellen die hierbij horen

`rapport_aanvragen` (telemetrie_*, wagen_*, firmware, tokens),
`rapport_metingen`, `rapport_meldingen`, `tesla_meldingen_woordenboek`,
`rapport_commandos`, `rapport_telemetrie_log`, `rapport_logboek`,
`rapport_instellingen`. Migraties: in het websiteproject (`drizzle/migrations`,
o.a. 0002, 0010–0014).
