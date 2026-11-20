// End-to-end test van de poller tegen een nagebootste site en proxy (geen Tesla,
// geen docker). Controleert: taken ophalen -> config naar proxy -> status "actief"
// terugmelden, en: periode voorbij -> DELETE -> status "klaar".
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HIER = dirname(fileURLToPath(import.meta.url));

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const uit = await handler(req.method, req.url, body ? JSON.parse(body) : null, req.headers);
      res.writeHead(uit.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(uit.body ?? {}));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

function draaiPoller(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HIER, "poller.mjs"), "--eenmaal"], { env: { ...process.env, ...env } });
    let uit = "";
    p.stdout.on("data", (d) => (uit += d));
    p.stderr.on("data", (d) => (uit += d));
    p.on("close", (code) => resolve({ code, uit }));
  });
}

test("poller zet telemetrie aan en meldt 'actief'", async () => {
  const certs = mkdtempSync(join(tmpdir(), "certs-"));
  mkdirSync(join(certs, "certs"));
  writeFileSync(join(certs, "certs", "ca.pem"), "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n");

  const gemeld = [];
  let proxyBody = null;
  const site = await server((m, url, body, headers) => {
    assert.equal(headers.authorization, "Bearer geheim123");
    if (m === "GET" && url === "/api/telemetrie/taken") {
      return { body: { taken: [{ aanvraag_id: "a1", vin: "5YJSA1H20EF000002", telemetrie_status: "sleutel_toegevoegd", tesla_access_token: "tok" }],
        instellingen: { telemetrie_host: "t.example.eu", telemetrie_poort: 4433, telemetrie_uren: 24 } } };
    }
    if (m === "POST" && url === "/api/telemetrie/status") { gemeld.push(body); return { body: { ok: true } }; }
    if (m === "POST" && url === "/api/telemetrie/log") return { body: { ok: true } };
    return { status: 404, body: { error: "onbekend" } };
  });
  const proxy = await server((m, url, body) => {
    if (m === "POST" && url === "/api/1/vehicles/fleet_telemetry_config") { proxyBody = body; return { body: { response: { updated_vehicles: 1, skipped_vehicles: {} } } }; }
    return { status: 404, body: {} };
  });

  const r = await draaiPoller({
    SITE_URL: `http://127.0.0.1:${site.address().port}`,
    TELEMETRIE_SECRET: "geheim123",
    VC_PROXY: `http://127.0.0.1:${proxy.address().port}`,
    TELEMETRIE_CERTS_DIR: join(certs, "certs"),
  });
  site.close(); proxy.close();
  assert.equal(r.code, 0, r.uit);
  assert.equal(proxyBody.vins[0], "5YJSA1H20EF000002");
  assert.equal(proxyBody.config.hostname, "t.example.eu");
  assert.equal(gemeld.length, 1);
  assert.equal(gemeld[0].status, "actief");
  assert.equal(gemeld[0].aanvraag_id, "a1");
});

test("poller zet telemetrie uit na de meetperiode en meldt 'klaar'", async () => {
  const gemeld = [];
  let deleteUrl = null;
  const site = await server((m, url, body) => {
    if (m === "GET" && url === "/api/telemetrie/taken") {
      return { body: { taken: [{ aanvraag_id: "a2", vin: "5YJSA1H20EF000002", telemetrie_status: "actief", telemetrie_tot: "2020-01-01T00:00:00Z", tesla_access_token: "tok" }], instellingen: {} } };
    }
    if (m === "POST" && url === "/api/telemetrie/status") { gemeld.push(body); return { body: { ok: true } }; }
    return { body: { ok: true } };
  });
  const fleet = await server((m, url) => {
    if (m === "DELETE") { deleteUrl = url; return { body: { response: { updated_vehicles: 1 } } }; }
    return { status: 404, body: {} };
  });
  const r = await draaiPoller({
    SITE_URL: `http://127.0.0.1:${site.address().port}`,
    TELEMETRIE_SECRET: "geheim123",
    TESLA_FLEET_BASE: `http://127.0.0.1:${fleet.address().port}`,
    VC_PROXY: "http://127.0.0.1:1",
  });
  site.close(); fleet.close();
  assert.equal(r.code, 0, r.uit);
  assert.equal(deleteUrl, "/api/1/vehicles/5YJSA1H20EF000002/fleet_telemetry_config");
  assert.equal(gemeld.length, 1);
  assert.equal(gemeld[0].status, "klaar");
});

test("poller: actieve meting -> recent_alerts + fleet_telemetry_errors naar /api/telemetrie/meldingen", async () => {
  const meldingen = [];
  const gevraagd = [];
  const site = await server((m, url, body) => {
    if (m === "GET" && url === "/api/telemetrie/taken") {
      return { body: { taken: [{ aanvraag_id: "a3", vin: "5YJSA1E26HF000001", telemetrie_status: "actief", telemetrie_tot: "2099-01-01T00:00:00Z", tesla_access_token: "tok", firmware: "2026.20.6" }], instellingen: {} } };
    }
    if (m === "POST" && url === "/api/telemetrie/meldingen") { meldingen.push(...body.meldingen); return { body: { ok: true, ingevoegd: body.meldingen.length } }; }
    return { body: { ok: true } };
  });
  const fleet = await server((m, url) => {
    gevraagd.push(url);
    if (url.endsWith("/recent_alerts")) return { body: { response: { recent_alerts: [{ name: "BMS_w123_SW_Internal_Isolation", time: "2026-11-10T08:00:00Z", audience: ["service-fix"] }] } } };
    if (url.endsWith("/fleet_telemetry_errors")) return { body: { response: { fleet_telemetry_errors: [] } } };
    if (url === "/api/1/vehicles/5YJSA1E26HF000001") return { body: { response: { state: "online" } } };
    return { status: 404, body: {} };
  });
  const r = await draaiPoller({
    SITE_URL: `http://127.0.0.1:${site.address().port}`,
    TELEMETRIE_SECRET: "geheim123",
    TESLA_FLEET_BASE: `http://127.0.0.1:${fleet.address().port}`,
    VC_PROXY: "http://127.0.0.1:1",
  });
  site.close(); fleet.close();
  assert.equal(r.code, 0, r.uit);
  assert.ok(gevraagd.includes("/api/1/vehicles/5YJSA1E26HF000001/recent_alerts"), gevraagd.join(","));
  assert.ok(gevraagd.includes("/api/1/vehicles/5YJSA1E26HF000001/fleet_telemetry_errors"));
  assert.equal(meldingen.length, 1);
  assert.equal(meldingen[0].naam, "BMS_w123_SW_Internal_Isolation");
  assert.equal(meldingen[0].aanvraag_id, "a3");
});
