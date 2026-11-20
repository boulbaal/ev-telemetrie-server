// Zet de telemetrie-stroom AAN voor één wagen.
// De token wordt automatisch uit de database gehaald (en zo nodig vernieuwd),
// dus je hoeft enkel de VIN te geven.
//
// Gebruik:  node scripts/zet-telemetrie-aan.mjs <VIN>
//
// Vereist: de docker-stack draait (vehicle-command proxy op 127.0.0.1:4443)
// en de klant heeft onze sleutel al op zijn wagen gezet.
import { tokenVoorVin, VELDEN, certificaatKeten, instellingen } from "./lib.mjs";
import { meldStatus } from "./api.mjs";

const inst = await instellingen();
const HOST = inst.telemetrie_host || process.env.TELEMETRIE_HOST || "telemetrie.evbatterymotorservice.eu";
const POORT = parseInt(inst.telemetrie_poort || process.env.TELEMETRIE_POORT || "4433", 10);
const PROXY = process.env.VC_PROXY || "https://127.0.0.1:4443";

const vin = process.argv[2];
if (!vin) {
  console.error("Gebruik: node scripts/zet-telemetrie-aan.mjs <VIN>");
  process.exit(1);
}

const { token, aanvraag } = await tokenVoorVin(vin);
console.log(`Wagen ${vin} (${aanvraag.naam}) — telemetrie aanzetten naar ${HOST}:${POORT}`);

const body = {
  vins: [vin],
  config: { hostname: HOST, port: POORT, ca: certificaatKeten(), fields: VELDEN },
};

// De lokale proxy gebruikt een zelfondertekend certificaat.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const res = await fetch(`${PROXY}/api/1/vehicles/fleet_telemetry_config`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const tekst = await res.text();
console.log("Status:", res.status);
console.log(tekst);

if (res.ok) {
  let j = {};
  try { j = JSON.parse(tekst); } catch { /* laat staan */ }
  const geweigerd = j?.response?.skipped_vehicles;
  if (geweigerd && Object.values(geweigerd).some((v) => Array.isArray(v) && v.length)) {
    console.log("\nLET OP, de wagen is geweigerd:");
    for (const [reden, vins] of Object.entries(geweigerd)) {
      if (Array.isArray(vins) && vins.length) {
        const uitleg = {
          missing_key: "de sleutel staat nog niet op de wagen (klant moet die eerst toevoegen)",
          unsupported_hardware: "deze wagen wordt niet ondersteund (pre-2018 Model S/X)",
          unsupported_firmware: "de firmware is te oud",
          max_configs: "de wagen heeft al het maximum aantal configuraties",
        }[reden] ?? reden;
        console.log(`  - ${reden}: ${uitleg}`);
      }
    }
  } else {
    await meldStatus(aanvraag.aanvraag_id, "actief", `Telemetrie aangezet (handmatig) naar ${HOST}:${POORT}`);
    console.log("\nGelukt. Controleer met:  node scripts/status.mjs " + vin);
    console.log("De wagen neemt de configuratie over zodra hij online is.");
  }
}
