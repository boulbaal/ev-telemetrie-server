// Controleert in één keer alles voor een wagen:
//   1. Is er een aanvraag met een geldige token?
//   2. Staat onze sleutel op de wagen?
//   3. Is de telemetrie-configuratie actief en gesynchroniseerd?
//   4. Komen er al metingen binnen (in de database)?
//
// Gebruik:  node scripts/status.mjs <VIN>
//   of zonder VIN: toont alle bekende wagens.
import { alleAanvragen, tokenVoorVin, fleetBase } from "./lib.mjs";

const vin = process.argv[2];

function regel(ok, tekst, extra = "") {
  const teken = ok === true ? "✓" : ok === false ? "✗" : "…";
  console.log(`  ${teken} ${tekst}${extra ? "  " + extra : ""}`);
}

if (!vin) {
  const lijst = await alleAanvragen();
  const vins = [...new Set(lijst.filter((a) => a.vin).map((a) => `${a.vin}  (${a.naam}, ${a.telemetrie_status})`))];
  console.log("Diepe-analyse-aanvragen volgens de site:\n");
  vins.forEach((v) => console.log("  " + v));
  console.log("\nGebruik: node scripts/status.mjs <VIN>");
  process.exit(0);
}

console.log(`\nStatus voor ${vin}\n${"-".repeat(50)}`);

// 1. Token
let token;
try {
  const r = await tokenVoorVin(vin);
  token = r.token;
  regel(true, "Aanvraag met geldige token gevonden", `(${r.aanvraag.naam})`);
} catch (e) {
  regel(false, "Geen bruikbare token", e.message);
  process.exit(1);
}

// 2. Sleutel op de wagen?
try {
  const res = await fetch(`${fleetBase()}/api/1/vehicles/fleet_status`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ vins: [vin] }),
  });
  const j = await res.json();
  const info = j?.response?.vehicle_info?.[vin] ?? {};
  const gekoppeld = (j?.response?.key_paired_vins ?? []).includes(vin);
  regel(gekoppeld, gekoppeld ? "Onze sleutel staat op de wagen" : "Sleutel NIET op de wagen (klant moet hem nog toevoegen)");
  if (info.firmware_version) regel(true, "Firmware", info.firmware_version);
  if (info.fleet_telemetry_version) regel(true, "Telemetrie-versie in de wagen", info.fleet_telemetry_version);
} catch (e) {
  regel(false, "fleet_status faalde", e.message);
}

// 3. Telemetrie-configuratie
try {
  const res = await fetch(`${fleetBase()}/api/1/vehicles/${encodeURIComponent(vin)}/fleet_telemetry_config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await res.json();
  const cfg = j?.response;
  if (!cfg || !cfg.config) {
    regel(false, "Geen telemetrie-configuratie actief", "(draai zet-telemetrie-aan.mjs)");
  } else {
    regel(true, "Telemetrie-configuratie aanwezig", `hostname: ${cfg.config?.hostname ?? "?"}`);
    regel(cfg.synced === true, cfg.synced ? "Wagen heeft de configuratie overgenomen" : "Wagen heeft de configuratie NOG NIET overgenomen (komt zodra hij online is)");
    if (cfg.limit_reached) regel(false, "Maximum aantal configuraties bereikt op deze wagen");
  }
} catch (e) {
  regel(false, "Configuratie opvragen faalde", e.message);
}

// 4. Binnenkomende metingen staan in het beheer van de site
regel(null, "Metingen: zie het beheer van de site (/admin/rapporten -> Openen -> Telemetrie)");

console.log("");
