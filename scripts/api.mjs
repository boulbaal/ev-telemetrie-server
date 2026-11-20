// Verbinding met de website (Lovable): alles wat de pc met de site uitwisselt
// loopt via drie routes, beveiligd met één gedeeld geheim (TELEMETRIE_SECRET).
//   GET  /api/telemetrie/taken     -> welke wagens moeten aan/uit + instellingen
//   POST /api/telemetrie/status    -> actief / klaar / fout terugmelden
//   POST /api/telemetrie/metingen  -> metingen in batches
//   POST /api/telemetrie/log       -> logregel voor het beheer
//   POST /api/telemetrie/meldingen -> meldingen van de wagen (alerts, telemetriefouten)
//   POST /api/telemetrie/woordenboek -> Tesla's uitleg per melding
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HIER = dirname(fileURLToPath(import.meta.url));
export const WORTEL = join(HIER, "..");

/** .env inlezen (eenvoudig, zonder extra pakket). Bestaande env-waarden winnen. */
export function laadEnv(pad = join(WORTEL, ".env")) {
  if (!existsSync(pad)) return;
  for (const regel of readFileSync(pad, "utf8").split("\n")) {
    const m = regel.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
laadEnv();

export function siteUrl() {
  return (process.env.SITE_URL || "").replace(/\/+$/, "");
}

export function apiGeconfigureerd() {
  return !!(siteUrl() && process.env.TELEMETRIE_SECRET);
}

function kop() {
  return {
    Authorization: `Bearer ${process.env.TELEMETRIE_SECRET}`,
    "Content-Type": "application/json",
  };
}

async function roep(methode, pad, body, timeoutMs = 15000) {
  if (!apiGeconfigureerd()) throw new Error("SITE_URL / TELEMETRIE_SECRET ontbreken in .env");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${siteUrl()}${pad}`, {
      method: methode,
      headers: kop(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const tekst = await res.text();
    if (!res.ok) throw new Error(`${methode} ${pad} -> ${res.status}: ${tekst.slice(0, 200)}`);
    try { return JSON.parse(tekst); } catch { return {}; }
  } finally {
    clearTimeout(timer);
  }
}

/** Taken + instellingen ophalen. */
export async function haalTaken() {
  return roep("GET", "/api/telemetrie/taken");
}

/** Status terugmelden voor één aanvraag. */
export async function meldStatus(aanvraag_id, status, detail, tokens) {
  const body = { aanvraag_id, status };
  if (detail) body.detail = String(detail).slice(0, 500);
  if (tokens?.tesla_access_token) body.tesla_access_token = tokens.tesla_access_token;
  if (tokens?.tesla_refresh_token) body.tesla_refresh_token = tokens.tesla_refresh_token;
  return roep("POST", "/api/telemetrie/status", body);
}

/** Metingen in één batch versturen (max 500). */
export async function stuurMetingen(metingen) {
  if (!metingen.length) return { ok: true, ingevoegd: 0, genegeerd: 0 };
  return roep("POST", "/api/telemetrie/metingen", { metingen: metingen.slice(0, 500) }, 30000);
}

/** Wagenstatus (online/asleep/offline) + eventuele wake-up melden. Route kan nog ontbreken (404) -> null. */
let wagenRouteOntbreektTot = 0; // na een 404 10 min niet opnieuw proberen (site nog niet gepubliceerd)
export async function meldWagen(aanvraag_id, vin, wagen_status, gewekt) {
  if (Date.now() < wagenRouteOntbreektTot) return null;
  try {
    return await roep("POST", "/api/telemetrie/wagen", { aanvraag_id, vin, wagen_status, gewekt: !!gewekt });
  } catch (e) {
    if (/-> 404/.test(e.message)) { wagenRouteOntbreektTot = Date.now() + 10 * 60 * 1000; console.error("site heeft nog geen /api/telemetrie/wagen-route; over 10 min opnieuw"); return null; }
    console.error("wagenstatus melden faalde:", e.message);
    return null;
  }
}

/** Resultaat van een commando terugmelden. */
export async function meldCommando(id, status, resultaat) {
  return roep("POST", "/api/telemetrie/commando", { id, status, resultaat: String(resultaat ?? "").slice(0, 500) });
}

/** Logregel voor het beheer. */
export async function log(niveau, detail, aanvraag_id) {
  const body = { niveau, detail: String(detail).slice(0, 500) };
  if (aanvraag_id) body.aanvraag_id = aanvraag_id;
  try { return await roep("POST", "/api/telemetrie/log", body); } catch (e) {
    console.error("log naar site faalde:", e.message);
    return null;
  }
}

// Routes die op een oudere site nog kunnen ontbreken: na een 404 10 min overslaan.
const ontbreektTot = new Map();
async function roepOptioneel(pad, body, timeoutMs) {
  if (Date.now() < (ontbreektTot.get(pad) ?? 0)) return null;
  try { return await roep("POST", pad, body, timeoutMs); } catch (e) {
    if (/-> 404/.test(e.message)) { ontbreektTot.set(pad, Date.now() + 10 * 60 * 1000); console.error(`site heeft nog geen ${pad}; over 10 min opnieuw`); return null; }
    throw e;
  }
}

/** Meldingen (alerts / telemetriefouten) naar de site; null als de route nog ontbreekt. */
export async function stuurMeldingen(meldingen) {
  if (!meldingen?.length) return { ok: true, ingevoegd: 0, genegeerd: 0 };
  return roepOptioneel("/api/telemetrie/meldingen", { meldingen: meldingen.slice(0, 200) }, 30000);
}

/** Laat velden met null/undefined en lege lijsten weg (de site-schema's kennen ze als "optioneel", niet als null). */
export function zonderLeeg(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && !(Array.isArray(v) && v.length === 0)));
}

/** Woordenboek in stukken van 200 naar de site; geeft het aantal verstuurde items of null. */
export async function stuurWoordenboek(alle) {
  const items = alle.map(zonderLeeg);
  let n = 0;
  for (let i = 0; i < items.length; i += 200) {
    const r = await roepOptioneel("/api/telemetrie/woordenboek", { items: items.slice(i, i + 200) }, 30000);
    if (r === null) return n ? n : null;
    n += Math.min(200, items.length - i);
  }
  return n;
}
