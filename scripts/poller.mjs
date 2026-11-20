// Poller: de schakel tussen de website en Tesla.
//
// Elke minuut vraagt hij de site welke wagens een diepe analyse hebben:
//   - status "sleutel_toegevoegd": klant heeft onze sleutel op de wagen gezet
//       -> telemetrie aanzetten via de lokale vehicle-command proxy
//       -> site krijgt status "actief" (of "fout" met uitleg)
//   - status "actief" en de meetperiode is voorbij
//       -> configuratie verwijderen bij Tesla -> site krijgt status "klaar"
//
// Gebruik:  node scripts/poller.mjs          (blijft draaien)
//           node scripts/poller.mjs --eenmaal (één ronde, handig om te testen)
//
// Vereist: .env met SITE_URL + TELEMETRIE_SECRET, de docker-stack draait
// (proxy op 127.0.0.1:4443) en certs/ bestaat.
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { WORTEL, apiGeconfigureerd, haalTaken, meldStatus, meldWagen, meldCommando, log, stuurMeldingen, stuurWoordenboek } from "./api.mjs";
import { beslis, beslisWagen, commandoStappen, beoordeelCommandoAntwoord, configBody, beoordeelConfigAntwoord, MAX_POGINGEN, veldenVoor, meldingenUitRecentAlerts, meldingenUitTelemetrieFouten } from "./beslis.mjs";
import { haalWoordenboek } from "./woordenboek.mjs";

const PROXY = process.env.VC_PROXY || "https://127.0.0.1:4443";
const FLEET_BASE = process.env.TESLA_FLEET_BASE || "https://fleet-api.prd.eu.vn.cloud.tesla.com";
const AUTH_TOKEN_URL = (process.env.TESLA_AUTH_BASE || "https://auth.tesla.com") + "/oauth2/v3/token";
const INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "60000", 10);
const EENMAAL = process.argv.includes("--eenmaal");

// De lokale proxy gebruikt een zelfondertekend certificaat.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

if (!apiGeconfigureerd()) {
  console.error("SITE_URL / TELEMETRIE_SECRET ontbreken in .env");
  process.exit(1);
}

/** Het CA-certificaat dat de wagen moet vertrouwen (eigen CA of Let's Encrypt-keten). */
function caPem() {
  const map = process.env.TELEMETRIE_CERTS_DIR || join(WORTEL, "certs");
  for (const naam of ["ca.pem", "fullchain.pem"]) {
    const pad = join(map, naam);
    if (existsSync(pad)) return readFileSync(pad, "utf8");
  }
  throw new Error("certs/ca.pem of certs/fullchain.pem niet gevonden (zie README, certificaat).");
}

async function vernieuwToken(taak) {
  if (!taak.tesla_refresh_token) throw new Error("geen refresh-token bij deze aanvraag");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.TESLA_CLIENT_ID || "",
    refresh_token: taak.tesla_refresh_token,
  });
  const res = await fetch(AUTH_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`token vernieuwen faalde: ${res.status}`);
  const j = await res.json();
  return { tesla_access_token: j.access_token, tesla_refresh_token: j.refresh_token || taak.tesla_refresh_token };
}

const pogingen = new Map(); // aanvraag_id -> aantal mislukte aanzet-pogingen

async function zetAan(taak, instellingen) {
  const body = configBody(taak.vin, instellingen, caPem(), veldenVoor(taak.firmware));
  let token = taak.tesla_access_token;
  let nieuweTokens = null;

  for (let ronde = 0; ronde < 2; ronde++) {
    const res = await fetch(`${PROXY}/api/1/vehicles/fleet_telemetry_config`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const antwoordTekst = await res.text();
    let json = null;
    try { json = JSON.parse(antwoordTekst); } catch { /* geen json */ }
    const uitslag = beoordeelConfigAntwoord(res.status, json);
    if (!uitslag.ok) {
      // Het antwoord van Tesla/proxy bewaren, anders is een 400 niet te onderzoeken.
      const kort = antwoordTekst.replace(/\s+/g, " ").slice(0, 300);
      uitslag.uitleg = `${uitslag.uitleg}${kort ? ` — antwoord: ${kort}` : ""}`;
      console.log(`${taak.vin}: fleet_telemetry_config -> ${res.status} ${kort}`);
    }

    if (uitslag.ok) {
      pogingen.delete(taak.aanvraag_id);
      await meldStatus(taak.aanvraag_id, "actief", `Telemetrie aangezet naar ${instellingen.telemetrie_host}:${instellingen.telemetrie_poort}`, nieuweTokens);
      console.log(`✓ ${taak.vin}: telemetrie actief`);
      return;
    }
    if (uitslag.reden === "token_verlopen" && ronde === 0) {
      nieuweTokens = await vernieuwToken(taak);
      token = nieuweTokens.tesla_access_token;
      continue;
    }
    const n = (pogingen.get(taak.aanvraag_id) ?? 0) + 1;
    pogingen.set(taak.aanvraag_id, n);
    const tekst = `${uitslag.uitleg} (${uitslag.reden}, poging ${n})`;
    if (uitslag.definitief || n >= MAX_POGINGEN) {
      await meldStatus(taak.aanvraag_id, "fout", tekst, nieuweTokens);
      console.log(`✗ ${taak.vin}: ${tekst} — opgegeven`);
    } else {
      await log("warn", tekst, taak.aanvraag_id);
      console.log(`… ${taak.vin}: ${tekst} — probeer later opnieuw`);
    }
    return;
  }
}

async function zetUit(taak) {
  const res = await fetch(`${FLEET_BASE}/api/1/vehicles/${encodeURIComponent(taak.vin)}/fleet_telemetry_config`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${taak.tesla_access_token}` },
  });
  const ok = res.ok || res.status === 404; // 404: er was al geen configuratie meer
  await meldStatus(taak.aanvraag_id, ok ? "klaar" : "fout", ok ? "Meetperiode voorbij, telemetrie uitgezet" : `Uitzetten faalde: ${res.status}`);
  console.log(`${ok ? "✓" : "✗"} ${taak.vin}: ${ok ? "telemetrie uitgezet, meting klaar" : "uitzetten faalde " + res.status}`);
}

// ---- Wagen bewaken: status opvragen en zo nodig wakker houden ----
const WAGEN_CHECK_MS = parseInt(process.env.WAGEN_CHECK_MS || "120000", 10);
const wagenGeheugen = new Map(); // aanvraag_id -> { laatsteCheckMs, laatsteWakeMs, state }

async function teslaStatus(taak) {
  let token = taak.tesla_access_token;
  for (let ronde = 0; ronde < 2; ronde++) {
    const res = await fetch(`${FLEET_BASE}/api/1/vehicles/${encodeURIComponent(taak.vin)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 && ronde === 0) {
      const nieuw = await vernieuwToken(taak);
      token = nieuw.tesla_access_token;
      await meldStatus(taak.aanvraag_id, taak.telemetrie_status, "Token vernieuwd (wagenbewaking)", nieuw);
      continue;
    }
    if (!res.ok) throw new Error(`vehicle ${res.status}`);
    const j = await res.json();
    return { state: j?.response?.state ?? null, token };
  }
  throw new Error("token vernieuwen mislukt");
}

async function bewaakWagen(taak, instellingen) {
  const nu = Date.now();
  const g = wagenGeheugen.get(taak.aanvraag_id) ?? { laatsteCheckMs: null, laatsteWakeMs: null, state: null };
  if (g.laatsteCheckMs != null && nu - g.laatsteCheckMs < WAGEN_CHECK_MS) return;
  g.laatsteCheckMs = nu;
  const { state, token } = await teslaStatus(taak);
  const wakkerHouden = instellingen.telemetrie_wakker_houden !== false; // standaard aan
  const b = beslisWagen({ state, wakkerHouden, laatsteWakeMs: g.laatsteWakeMs, nuMs: nu, laatsteSoc: taak.laatste_soc ?? null });
  let gewekt = false;
  if (b.wekken) {
    const res = await fetch(`${FLEET_BASE}/api/1/vehicles/${encodeURIComponent(taak.vin)}/wake_up`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    gewekt = res.ok;
    g.laatsteWakeMs = nu;
    console.log(`${taak.vin}: ${b.reden} -> wake_up ${res.status}`);
  }
  if (state !== g.state || gewekt) {
    console.log(`${taak.vin}: wagen ${state ?? "onbekend"}${gewekt ? " (wake-up verstuurd)" : ""}`);
  }
  g.state = state;
  wagenGeheugen.set(taak.aanvraag_id, g);
  await meldWagen(taak.aanvraag_id, taak.vin, state, gewekt);
}

// ---- Diagnose: recente meldingen + telemetriefouten van de wagen (elke 30 min) ----
const DIAG_MS = parseInt(process.env.DIAG_CHECK_MS || "1800000", 10);
const diagGeheugen = new Map(); // aanvraag_id -> laatste check (ms)

async function fleetGet(taak, pad) {
  let token = taak.tesla_access_token;
  for (let ronde = 0; ronde < 2; ronde++) {
    const res = await fetch(`${FLEET_BASE}/api/1/vehicles/${encodeURIComponent(taak.vin)}/${pad}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 && ronde === 0) {
      const nieuw = await vernieuwToken(taak);
      token = nieuw.tesla_access_token;
      taak.tesla_access_token = token;
      await meldStatus(taak.aanvraag_id, taak.telemetrie_status, `Token vernieuwd (${pad})`, nieuw);
      continue;
    }
    if (!res.ok) throw new Error(`${pad} ${res.status}`);
    return res.json();
  }
  throw new Error("token vernieuwen mislukt");
}

async function diagnose(taak) {
  const nu = Date.now();
  const vorige = diagGeheugen.get(taak.aanvraag_id);
  if (vorige != null && nu - vorige < DIAG_MS) return;
  diagGeheugen.set(taak.aanvraag_id, nu);
  const meldingen = [];
  for (const [pad, omzetten] of [["recent_alerts", meldingenUitRecentAlerts], ["fleet_telemetry_errors", meldingenUitTelemetrieFouten]]) {
    try {
      const j = await fleetGet(taak, pad);
      const m = omzetten(j, taak.vin);
      console.log(`${taak.vin}: ${pad} -> ${m.length} meldingen`);
      meldingen.push(...m);
    } catch (e) {
      console.error(`${taak.vin}: ${pad} faalde: ${e.message}`);
    }
  }
  if (meldingen.length) await stuurMeldingen(meldingen.map((m) => ({ ...m, aanvraag_id: taak.aanvraag_id })));
}

// ---- Woordenboek van Tesla-meldingen: bij start en daarna elke 24 u (enkel als het veranderde) ----
const WOORDENBOEK_MS = 24 * 3600 * 1000;
let woordenboekHash = null;
let woordenboekCheck = 0;
async function woordenboekBijwerken() {
  if (Date.now() - woordenboekCheck < WOORDENBOEK_MS) return;
  woordenboekCheck = Date.now();
  try {
    const { hash, items } = await haalWoordenboek(process.env.TESLA_ALERT_DICT_URL || undefined);
    if (hash === woordenboekHash) return;
    const n = await stuurWoordenboek(items);
    if (n === null) { woordenboekCheck = Date.now() - WOORDENBOEK_MS + 10 * 60 * 1000; return; } // route ontbreekt: over 10 min opnieuw
    woordenboekHash = hash;
    console.log(`woordenboek: ${n} meldingen naar de site`);
  } catch (e) {
    console.error("woordenboek bijwerken faalde:", e.message);
  }
}

// ---- Commando's van het beheer (enkel op vraag van de klant) ----
async function voerCommandoUit(cmd, taak) {
  const stappen = commandoStappen(cmd.commando, cmd.params);
  if (!stappen) { await meldCommando(cmd.id, "fout", `onbekend commando ${cmd.commando}`); return; }
  let token = taak?.tesla_access_token;
  if (!token) { await meldCommando(cmd.id, "fout", "geen Tesla-token bij deze aanvraag"); return; }
  const verslag = [];
  for (const aanroep of stappen) {
    const url = `${PROXY}/${aanroep.pad.replace("{vin}", encodeURIComponent(cmd.vin))}`;
    let u = null;
    for (let ronde = 0; ronde < 2; ronde++) {
      const res = await fetch(url, {
        method: aanroep.methode,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: aanroep.body === undefined ? undefined : JSON.stringify(aanroep.body),
      });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { /* geen json */ }
      u = beoordeelCommandoAntwoord(res.status, json);
      if (u.tokenVerlopen && ronde === 0 && taak) {
        const nieuw = await vernieuwToken(taak);
        token = nieuw.tesla_access_token;
        taak.tesla_access_token = token;
        await meldStatus(taak.aanvraag_id, taak.telemetrie_status, "Token vernieuwd (commando)", nieuw);
        continue;
      }
      console.log(`${cmd.vin}: commando ${cmd.commando} (${aanroep.pad.split("/").pop()}) -> ${res.status} ${u.uitleg}`);
      break;
    }
    verslag.push(`${aanroep.pad.split("/").pop()}: ${u.uitleg}`);
    if (!u.ok) { await meldCommando(cmd.id, "fout", verslag.join(" · ")); return; }
    if (stappen.length > 1) await new Promise((r) => setTimeout(r, 1500));
  }
  await meldCommando(cmd.id, "ok", stappen.length > 1 ? verslag.join(" · ") : "uitgevoerd");
}

async function ronde() {
  let data;
  try {
    data = await haalTaken();
  } catch (e) {
    console.error("taken ophalen faalde:", e.message);
    return;
  }
  const taken = data?.taken ?? [];
  const instellingen = data?.instellingen ?? {};
  if (!EENMAAL || process.env.WOORDENBOEK_TEST) await woordenboekBijwerken();
  for (const cmd of data?.commandos ?? []) {
    try { await voerCommandoUit(cmd, taken.find((t) => t.aanvraag_id === cmd.aanvraag_id) ?? null); }
    catch (e) { console.error(`commando ${cmd.commando}: ${e.message}`); await meldCommando(cmd.id, "fout", e.message).catch(() => {}); }
  }
  if (!taken.length) {
    console.log(new Date().toISOString(), "geen taken");
    return;
  }
  for (const taak of taken) {
    const { actie } = beslis(taak);
    try {
      if (actie === "aanzetten") await zetAan(taak, instellingen);
      else if (actie === "uitzetten") await zetUit(taak);
      else if (taak.telemetrie_status === "actief") {
        await bewaakWagen(taak, instellingen);
        await diagnose(taak);
      }
    } catch (e) {
      console.error(`${taak.vin}: ${e.message}`);
      await log("error", `${actie}: ${e.message}`, taak.aanvraag_id);
    }
  }
}

console.log(`Poller gestart (${EENMAAL ? "eenmalig" : "elke " + INTERVAL_MS / 1000 + " s"}), proxy ${PROXY}`);
await ronde();
if (!EENMAAL) setInterval(ronde, INTERVAL_MS);
