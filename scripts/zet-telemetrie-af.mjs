// Zet de telemetrie-stroom AF voor één wagen (bv. na de analyse, om kosten en
// dataverkeer te beperken, of op vraag van de klant).
//
// Gebruik:  node scripts/zet-telemetrie-af.mjs <VIN>
import { tokenVoorVin, fleetBase } from "./lib.mjs";
import { meldStatus } from "./api.mjs";

const vin = process.argv[2];
if (!vin) {
  console.error("Gebruik: node scripts/zet-telemetrie-af.mjs <VIN>");
  process.exit(1);
}

const { token, aanvraag } = await tokenVoorVin(vin);
console.log(`Wagen ${vin} (${aanvraag.naam}) — telemetrie uitzetten`);

const res = await fetch(`${fleetBase()}/api/1/vehicles/${encodeURIComponent(vin)}/fleet_telemetry_config`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${token}` },
});
console.log("Status:", res.status);
console.log(await res.text());
if (res.ok || res.status === 404) await meldStatus(aanvraag.aanvraag_id, "klaar", "Telemetrie uitgezet (handmatig)");
if (res.ok) console.log("\nDe stroom is gestopt. De klant kan zijn sleutel eventueel ook zelf verwijderen in de auto.");
