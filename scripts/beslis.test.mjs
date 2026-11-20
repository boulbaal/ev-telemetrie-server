import { test } from "node:test";
import assert from "node:assert/strict";
import { beslis, beslisWagen, WAKE_INTERVAL_MS, commandoAanroep, commandoStappen, beoordeelCommandoAntwoord, configBody, beoordeelConfigAntwoord, VELDEN, ALERT_TYPES, firmwareMinstens, veldenVoor, meldingenUitRecentAlerts, meldingenUitTelemetrieFouten } from "./beslis.mjs";

test("beslis: sleutel_toegevoegd -> aanzetten", () => {
  assert.deepEqual(beslis({ telemetrie_status: "sleutel_toegevoegd" }), { actie: "aanzetten" });
});

test("beslis: actief binnen de periode -> niets, erna -> uitzetten", () => {
  const nu = new Date("2026-10-22T12:00:00Z");
  assert.deepEqual(beslis({ telemetrie_status: "actief", telemetrie_tot: "2026-10-22T18:00:00Z" }, nu), { actie: "niets" });
  assert.deepEqual(beslis({ telemetrie_status: "actief", telemetrie_tot: "2026-10-22T11:59:00Z" }, nu), { actie: "uitzetten" });
  assert.deepEqual(beslis({ telemetrie_status: "actief", telemetrie_tot: null }, nu), { actie: "niets" });
});

test("beslis: andere statussen -> niets", () => {
  for (const s of ["geen", "wacht_sleutel", "klaar", "fout"]) {
    assert.deepEqual(beslis({ telemetrie_status: s }), { actie: "niets" });
  }
});

test("configBody bevat host, poort, ca en velden", () => {
  const b = configBody("5YJSA1H20EF000002", { telemetrie_host: "t.example.eu", telemetrie_poort: "4433" }, "-----BEGIN CERTIFICATE-----", VELDEN);
  assert.deepEqual(b.vins, ["5YJSA1H20EF000002"]);
  assert.equal(b.config.hostname, "t.example.eu");
  assert.equal(b.config.port, 4433);
  assert.ok(b.config.ca.startsWith("-----BEGIN"));
  assert.ok("BrickVoltageMax" in b.config.fields);
});

test("beoordeelConfigAntwoord: ok, missing_key (niet definitief), unsupported_hardware (definitief), 401", () => {
  assert.deepEqual(beoordeelConfigAntwoord(200, { response: { updated_vehicles: 1, skipped_vehicles: {} } }), { ok: true });
  const mk = beoordeelConfigAntwoord(200, { response: { skipped_vehicles: { missing_key: ["5YJ"] } } });
  assert.equal(mk.ok, false);
  assert.equal(mk.reden, "missing_key");
  assert.equal(mk.definitief, false);
  const uh = beoordeelConfigAntwoord(200, { response: { skipped_vehicles: { unsupported_hardware: ["5YJ"] } } });
  assert.equal(uh.definitief, true);
  assert.equal(beoordeelConfigAntwoord(401, null).reden, "token_verlopen");
  assert.equal(beoordeelConfigAntwoord(500, null).definitief, false);
  assert.equal(beoordeelConfigAntwoord(400, null).definitief, true);
});

test("beslisWagen: slaapt + wakker houden aan -> wekken", () => {
  const r = beslisWagen({ state: "asleep", wakkerHouden: true, laatsteWakeMs: null, nuMs: 1_000_000, laatsteSoc: 43 });
  assert.equal(r.wekken, true);
});
test("beslisWagen: online -> niet wekken", () => {
  assert.equal(beslisWagen({ state: "online", wakkerHouden: true, laatsteWakeMs: null, nuMs: 1, laatsteSoc: null }).wekken, false);
});
test("beslisWagen: offline -> niet wekken (geen internet)", () => {
  assert.equal(beslisWagen({ state: "offline", wakkerHouden: true, laatsteWakeMs: null, nuMs: 1, laatsteSoc: null }).wekken, false);
});
test("beslisWagen: instelling uit -> nooit wekken", () => {
  assert.equal(beslisWagen({ state: "asleep", wakkerHouden: false, laatsteWakeMs: null, nuMs: 1, laatsteSoc: 80 }).wekken, false);
});
test("beslisWagen: SoC onder 15 % -> niet wekken", () => {
  assert.equal(beslisWagen({ state: "asleep", wakkerHouden: true, laatsteWakeMs: null, nuMs: 1, laatsteSoc: 12 }).wekken, false);
});
test("beslisWagen: niet vaker dan elke 10 min", () => {
  const nu = 20 * 60 * 1000;
  assert.equal(beslisWagen({ state: "asleep", wakkerHouden: true, laatsteWakeMs: nu - 5 * 60 * 1000, nuMs: nu, laatsteSoc: 50 }).wekken, false);
  assert.equal(beslisWagen({ state: "asleep", wakkerHouden: true, laatsteWakeMs: nu - WAKE_INTERVAL_MS, nuMs: nu, laatsteSoc: 50 }).wekken, true);
});

test("commandoAanroep: laadlimiet begrensd 50-100", () => {
  assert.deepEqual(commandoAanroep("laadlimiet", { percent: 120 }).body, { percent: 100 });
  assert.deepEqual(commandoAanroep("laadlimiet", { percent: 10 }).body, { percent: 50 });
  assert.equal(commandoAanroep("laadlimiet", { percent: 90 }).pad, "api/1/vehicles/{vin}/command/set_charge_limit");
  assert.equal(commandoAanroep("onzin", {}), null);
});
test("beoordeelCommandoAntwoord", () => {
  assert.equal(beoordeelCommandoAntwoord(200, { response: { result: true, reason: "" } }).ok, true);
  assert.equal(beoordeelCommandoAntwoord(200, { response: { result: false, reason: "charging" } }).ok, false);
  assert.equal(beoordeelCommandoAntwoord(403, {}).ok, false);
  assert.equal(beoordeelCommandoAntwoord(401, {}).tokenVerlopen, true);
});

test("commandoStappen: verbinding_feedback = knipperen + claxon", () => {
  const st = commandoStappen("verbinding_feedback");
  assert.equal(st.length, 2);
  assert.equal(st[0].pad, "api/1/vehicles/{vin}/command/flash_lights");
  assert.equal(st[1].pad, "api/1/vehicles/{vin}/command/honk_horn");
  assert.equal(commandoStappen("claxon").length, 1);
  assert.equal(commandoStappen("onzin"), null);
});

test("configBody vraagt alerts op (service, service-fix, customer)", () => {
  const b = configBody("5YJSA1E26HF000001", { telemetrie_host: "t", telemetrie_poort: 4433 }, "ca", VELDEN);
  assert.deepEqual(b.config.alert_types, ["service", "service-fix", "customer"]);
  assert.deepEqual(ALERT_TYPES, b.config.alert_types);
  assert.equal("alert_types" in configBody("x", {}, "ca", VELDEN, []).config, false);
});

test("VELDEN bevat de diagnosevelden van de specialist, niet de 2026.32-velden", () => {
  for (const v of ["IsolationResistance", "BMSState", "Hvil", "DiStateR", "DiStateF", "DetailedChargeState", "Gear", "BmsFullchargecomplete", "BrickVoltageMax", "NumBrickVoltageMin", "PackVoltage", "Soc"]) assert.ok(v in VELDEN, v);
  assert.equal("NominalFullPackEnergyKwh" in VELDEN, false);
  assert.equal(VELDEN.BMSState.interval_seconds, 1);
});

test("firmwareMinstens en veldenVoor", () => {
  assert.equal(firmwareMinstens("2026.20.6", "2026.32"), false);
  assert.equal(firmwareMinstens("2026.32", "2026.32"), true);
  assert.equal(firmwareMinstens("2026.38.1 abc", "2026.32"), true);
  assert.equal(firmwareMinstens("2027.2", "2026.32"), true);
  assert.equal(firmwareMinstens(null, "2026.32"), false);
  assert.equal(firmwareMinstens("onbekend", "2026.32"), false);
  assert.equal("BrickSocMinPercent" in veldenVoor("2026.20.6"), false);
  assert.ok("BrickSocMinPercent" in veldenVoor("2026.32.1"));
  assert.ok("NominalFullPackEnergyKwh" in veldenVoor("2026.40"));
});

test("meldingenUitRecentAlerts: vorm van Tesla + rommel", () => {
  const j = { response: { recent_alerts: [
    { name: "BMS_w035_SW_Isolation", time: "2026-11-01T10:00:00.000Z", audience: ["service-fix", "customer"], user_text: "Service is required" },
    { name: "" }, null,
  ] } };
  const m = meldingenUitRecentAlerts(j, "5YJ");
  assert.equal(m.length, 1);
  assert.equal(m[0].naam, "BMS_w035_SW_Isolation");
  assert.equal(m[0].bron, "recent_alerts");
  assert.equal(m[0].gestart_op, "2026-11-01T10:00:00.000Z");
  assert.deepEqual(m[0].doelgroepen, ["service-fix", "customer"]);
  assert.deepEqual(meldingenUitRecentAlerts({}, "5YJ"), []);
  assert.deepEqual(meldingenUitRecentAlerts(null, "5YJ"), []);
});

test("meldingenUitTelemetrieFouten", () => {
  const m = meldingenUitTelemetrieFouten({ response: { fleet_telemetry_errors: [{ name: "unsupported_field", error: "NominalFullPackEnergyKwh not supported", vin: "5YJ" }] } }, "5YJ");
  assert.equal(m.length, 1);
  assert.equal(m[0].soort, "telemetriefout");
  assert.equal(m[0].naam, "unsupported_field");
  assert.match(m[0].detail.error, /NominalFullPack/);
  assert.deepEqual(meldingenUitTelemetrieFouten({}, "5YJ"), []);
});
