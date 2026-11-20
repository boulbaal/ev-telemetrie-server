# Dagelijks gebruik, updates en problemen

## Dagelijks

Normaal hoeft er niets te gebeuren: de poller doet alles vanzelf.

```bash
docker compose ps                         # draait alles?
docker compose logs --since 1h poller     # wat deed de poller?
docker compose logs --since 1h bridge     # komen er metingen binnen?
node scripts/status.mjs                   # welke dossiers geeft de website door
node scripts/status.mjs <VIN>             # sleutel op de wagen? configuratie actief?
```

Een meting loopt 24 u. **Zet de server nooit uit tijdens een meting**: op het
einde verwijdert de poller de configuratie van de wagen.

## Code bijwerken

```bash
git pull
docker compose up -d --build bridge       # bridge heeft een eigen image
docker compose restart poller             # poller leest scripts/ rechtstreeks
node --test scripts/*.test.mjs bridge/*.test.mjs
```

Nieuwe velden opvragen: voeg ze toe aan `VELDEN` in `scripts/beslis.mjs`.
Ze gelden pas voor **nieuwe** metingen (bij het aanzetten).

## Noodgevallen

```bash
node scripts/zet-telemetrie-af.mjs <VIN>  # configuratie meteen van de wagen halen
node scripts/zet-telemetrie-aan.mjs <VIN> # opnieuw aanzetten
```

## Problemen oplossen

| Symptoom | Oorzaak / oplossing |
|---|---|
| Poller: `SITE_URL / TELEMETRIE_SECRET ontbreken` | `.env` niet ingevuld |
| Website geeft **401** | `TELEMETRIE_SECRET` verschilt tussen `.env` en de website |
| `missing_key` | De klant heeft de virtuele sleutel nog niet toegevoegd. De poller probeert een uur lang om de 5 min opnieuw. |
| `unsupported_hardware` | Oude MCU1-computer: geen telemetrie mogelijk |
| `unsupported_firmware` | Firmware te oud (< 2024.26, of < 2025.20 bij een Intel S/X) |
| *hostname domain does not match with partner account* | De hostname valt niet onder het geregistreerde partnerdomein (zie TESLA-APP.md) |
| Configuratie OK, maar geen metingen | DNS of poort 4433 (INSTALLATIE stap 2–3), certificaat op een andere hostnaam, of de wagen slaapt (wakker houden aan?) |
| Wagen valt in slaap, `wake_up` geeft 403 | Het token van de klant mist `vehicle_cmds`. De klant moet de toegang intrekken en opnieuw inloggen met alle rechten. |
| Veld komt nooit binnen | Bekijk de meldingen van het type `telemetriefout` (bv. `veld:NominalFullPackEnergyKwh` = firmware te oud) |
| Geen meldingen (alerts) | `alert_types` ontbreekt in de configuratie (staat er standaard in) |

## Geleerd tijdens de testmetingen (okt–nov 2026)

- Een Model S 2017 (Intel/MCU2, firmware 2026.20.6) stuurt: Soc, EnergyRemaining,
  RatedRange, PackVoltage/Current, BrickVoltageMax/Min + bricknummer,
  ModuleTempMax/Min, LifetimeEnergyUsed en Odometer (dat laatste om de ±5 min).
- `BMSState` werd aanvaard, maar kwam in 24 u niet door. Het staat nu op
  interval 1 s, samen met andere "event"-velden om te testen.
- De wagen rapporteert niet-ondersteunde velden als `errors`-bericht. De bridge
  zet die om naar een `telemetriefout`.
- Laat een pc of laptop nooit in slaapstand gaan tijdens een meting. Op een
  laptop: "deksel dicht" laten negeren. Herstart daarna; herstart niet de
  sessiedienst, want die sluit je bureaublad af.
