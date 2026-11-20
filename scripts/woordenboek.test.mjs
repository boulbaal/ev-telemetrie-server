import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, woordenboekItems, hash } from "./woordenboek.mjs";

const CSV = [
  "SignalName,Condition,ClearCondition,Description,PotentialImpact,CustomerFacingMessage1,CustomerFacingMessage2,Audiences,Models",
  'BMS_w035_SW_Isolation,"Isolation low, contactors closed",Isolation ok,There is an external or internal isolation alert while pack contactors are closed.,"Vehicle may not drive",Service is required,Not Available,customer;service-fix,Model S 2012-2020;Model X 2015-2020',
  'ADSP_w002_exception,x,y,Audio exception,z,Not Available,Not Available,service,Model 3 2024+',
  'DI_d004_overTemp,a,b,DI_d004_overTemp,c,Not Available,Not Available,service,"Model S 2012-2020"',
  '"BMS_w999_Quote","He said ""hi""\nnext line",c,d,e,f,g,service,Model Y',
].join("\n") + "\n";

test("parseCsv: aanhalingstekens, dubbele quotes en regeleinden", () => {
  const r = parseCsv(CSV);
  assert.equal(r.length, 5);
  assert.equal(r[1][1], "Isolation low, contactors closed");
  assert.equal(r[4][1], 'He said "hi"\nnext line');
});

test("woordenboekItems: enkel BMS/DI, lege beschrijving -> null, doelgroepen/modellen gesplitst", () => {
  const items = woordenboekItems(CSV);
  assert.deepEqual(items.map((i) => i.naam), ["BMS_w035_SW_Isolation", "DI_d004_overTemp", "BMS_w999_Quote"]);
  assert.deepEqual(items[0].doelgroepen, ["customer", "service-fix"]);
  assert.deepEqual(items[0].modellen, ["Model S 2012-2020", "Model X 2015-2020"]);
  assert.equal(items[0].klanttekst, "Service is required");
  assert.equal(items[1].beschrijving, null); // beschrijving = naam -> niets zeggend
  assert.equal(items[1].klanttekst, null);
});

test("hash is stabiel", () => {
  assert.equal(hash("abc"), hash("abc"));
  assert.notEqual(hash("abc"), hash("abd"));
});

test("zonderLeeg laat null en lege lijsten weg (site-schema: optioneel, niet null)", async () => {
  process.env.SITE_URL ||= "http://x"; process.env.TELEMETRIE_SECRET ||= "x";
  const { zonderLeeg } = await import("./api.mjs");
  assert.deepEqual(zonderLeeg({ naam: "BMS_x", beschrijving: null, gevolg: undefined, doelgroepen: [], modellen: ["Model S"] }), { naam: "BMS_x", modellen: ["Model S"] });
});
