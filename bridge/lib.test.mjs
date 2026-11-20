import { test } from "node:test";
import assert from "node:assert/strict";
import { waardeUit, ontleedTopic, maakMeting, maakMelding, tijdUit, Buffer } from "./lib.mjs";

test("waardeUit haalt getal, tekst en boolean uit fleet-telemetry json", () => {
  assert.equal(waardeUit({ doubleValue: 3.5 }), 3.5);
  assert.equal(waardeUit({ intValue: 7 }), 7);
  assert.equal(waardeUit({ stringValue: "Charging" }), "Charging");
  assert.equal(waardeUit({ booleanValue: false }), false);
  assert.equal(waardeUit(12), 12);
  assert.equal(waardeUit({ onbekend: 1 }), '{"onbekend":1}');
});

test("ontleedTopic herkent signalen, alerts en fouten", () => {
  assert.deepEqual(ontleedTopic("telemetry/5YJSA1H20EF000002/v/Soc"), { vin: "5YJSA1H20EF000002", soort: "v", veld: "Soc" });
  assert.deepEqual(ontleedTopic("telemetry/5YJSA1H20EF000002/alerts"), { vin: "5YJSA1H20EF000002", soort: "alerts" });
  assert.deepEqual(ontleedTopic("telemetry/5YJSA1H20EF000002/errors"), { vin: "5YJSA1H20EF000002", soort: "errors" });
  assert.equal(ontleedTopic("iets/anders"), null);
  assert.equal(ontleedTopic("telemetry/TEKORT/v/Soc"), null);
});

test("maakMeting bouwt een meting met tijdstempel uit payload of 'nu'", () => {
  const nu = new Date("2026-10-21T10:00:00Z");
  const m = maakMeting("telemetry/5YJSA1H20EF000002/v/PackVoltage", JSON.stringify({ doubleValue: 391.2 }), nu);
  assert.deepEqual(m, { vin: "5YJSA1H20EF000002", signaal: "PackVoltage", waarde: 391.2, gemeten_op: "2026-10-21T10:00:00.000Z" });

  const m2 = maakMeting("telemetry/5YJSA1H20EF000002/v/BMSState", JSON.stringify({ stringValue: "Drive", createdAt: "2026-10-21T09:59:30Z" }), nu);
  assert.equal(m2.waarde, "Drive");
  assert.equal(m2.gemeten_op, "2026-10-21T09:59:30.000Z");

  assert.equal(maakMeting("telemetry/5YJSA1H20EF000002/alerts", "{}", nu), null);
  assert.equal(maakMeting("telemetry/5YJSA1H20EF000002/v/Soc", "niet-json", nu).waarde, "niet-json");
});

test("Buffer verzamelt tot max en geeft stukken terug", () => {
  const b = new Buffer(3);
  assert.equal(b.voegToe({ a: 1 }), false);
  assert.equal(b.voegToe(null), false);
  assert.equal(b.voegToe({ a: 2 }), false);
  assert.equal(b.voegToe({ a: 3 }), true);
  b.voegToe({ a: 4 });
  assert.equal(b.lengte, 4);
  assert.deepEqual(b.neem(), [{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.equal(b.lengte, 1);
});

test("ontleedTopic: alerts/<naam>/current en errors/<naam>", () => {
  assert.deepEqual(ontleedTopic("telemetry/5YJSA1E26HF000001/alerts/BMS_w035_SW_Isolation/current"),
    { vin: "5YJSA1E26HF000001", soort: "alerts", naam: "BMS_w035_SW_Isolation", variant: "current" });
  assert.deepEqual(ontleedTopic("telemetry/5YJSA1E26HF000001/errors/abc"), { vin: "5YJSA1E26HF000001", soort: "errors", naam: "abc" });
});

test("tijdUit: iso, epoch en {seconds}", () => {
  assert.equal(tijdUit("2026-11-05T20:55:43Z"), "2026-11-05T20:55:43.000Z");
  assert.equal(tijdUit({ seconds: 1793832943 }), new Date(1793832943000).toISOString());
  assert.equal(tijdUit(1793832943), new Date(1793832943000).toISOString());
  assert.equal(tijdUit(""), null);
  assert.equal(tijdUit("0001-01-01T00:00:00Z"), null);
});

test("maakMelding: alert uit current-topic, history genegeerd", () => {
  const nu = new Date("2026-11-20T10:00:00Z");
  const p = JSON.stringify({ Name: "BMS_w035_SW_Isolation", StartedAt: "2026-11-20T09:00:00Z", EndedAt: "0001-01-01T00:00:00Z", Audiences: ["Customer", "Service_Fix"] });
  const m = maakMelding("telemetry/5YJSA1E26HF000001/alerts/BMS_w035_SW_Isolation/current", p, nu);
  assert.equal(m.length, 1);
  assert.equal(m[0].naam, "BMS_w035_SW_Isolation");
  assert.equal(m[0].soort, "alert");
  assert.equal(m[0].gestart_op, "2026-11-20T09:00:00.000Z");
  assert.equal(m[0].beeindigd_op, null);
  assert.deepEqual(m[0].doelgroepen, ["customer", "service-fix"]);
  assert.equal(maakMelding("telemetry/5YJSA1E26HF000001/alerts/BMS_w035_SW_Isolation/history", p, nu), null);
  assert.equal(maakMelding("telemetry/5YJSA1E26HF000001/v/Soc", "1", nu), null);
});

test("maakMelding: telemetriefout met field_name (zoals op 5/11 bij NominalFullPackEnergyKwh)", () => {
  const p = '{"Body":"","CreatedAt":"2026-11-05T20:55:43Z","Tags":{"field_name":"NominalFullPackEnergyKwh","name":"abc123"}}';
  const m = maakMelding("telemetry/5YJSA1E26HF000001/errors", p);
  assert.equal(m[0].naam, "veld:NominalFullPackEnergyKwh");
  assert.equal(m[0].soort, "telemetriefout");
  assert.equal(m[0].gestart_op, "2026-11-05T20:55:43.000Z");
});
