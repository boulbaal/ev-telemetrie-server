// Gedeelde hulpjes voor de handmatige scripts (status, zet-telemetrie-aan/af).
// Alles komt uit de website via scripts/api.mjs; er is geen aparte database
// meer op de pc. De poller doet dit normaal automatisch; deze scripts zijn
// voor controle en noodgevallen.
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { WORTEL, haalTaken, meldStatus } from "./api.mjs";
export { VELDEN } from "./beslis.mjs";
export { laadEnv, apiGeconfigureerd } from "./api.mjs";

const FLEET_BASE = process.env.TESLA_FLEET_BASE || "https://fleet-api.prd.eu.vn.cloud.tesla.com";
const AUTH_TOKEN_URL = (process.env.TESLA_AUTH_BASE || "https://auth.tesla.com") + "/oauth2/v3/token";

export function fleetBase() { return FLEET_BASE; }

/** Alle diepe-analyse-aanvragen die de site aan de pc toont (sleutel_toegevoegd / actief). */
export async function alleAanvragen() {
  const d = await haalTaken();
  return d?.taken ?? [];
}

export async function instellingen() {
  const d = await haalTaken();
  return d?.instellingen ?? {};
}

/** Zoekt de taak voor deze VIN. */
export async function vindAanvraagVoorVin(vin) {
  const lijst = await alleAanvragen();
  return lijst.find((a) => a.vin === vin && a.tesla_access_token) ?? null;
}

/** Vernieuwt de access token met de refresh token en meldt hem terug aan de site. */
export async function vernieuwToken(aanvraag) {
  if (!aanvraag.tesla_refresh_token) throw new Error("Geen refresh-token bewaard bij deze aanvraag.");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.TESLA_CLIENT_ID || "",
    refresh_token: aanvraag.tesla_refresh_token,
  });
  const res = await fetch(AUTH_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`Token vernieuwen faalde: ${res.status} ${await res.text()}`);
  const j = await res.json();
  aanvraag.tesla_access_token = j.access_token;
  if (j.refresh_token) aanvraag.tesla_refresh_token = j.refresh_token;
  await meldStatus(aanvraag.aanvraag_id, aanvraag.telemetrie_status, "Token vernieuwd (handmatig script)", {
    tesla_access_token: aanvraag.tesla_access_token,
    tesla_refresh_token: aanvraag.tesla_refresh_token,
  });
  console.log("→ Token vernieuwd en bewaard.");
  return aanvraag.tesla_access_token;
}

/** Geeft een werkende access token voor deze VIN; vernieuwt bij 401. */
export async function tokenVoorVin(vin) {
  const a = await vindAanvraagVoorVin(vin);
  if (!a) throw new Error(`Geen diepe-analyse-aanvraag met token voor VIN ${vin}. De klant moet eerst via de site inloggen en "Sleutel toegevoegd" klikken.`);
  const test = await fetch(`${FLEET_BASE}/api/1/vehicles`, { headers: { Authorization: `Bearer ${a.tesla_access_token}` } });
  if (test.status === 401) {
    console.log("Token verlopen, vernieuwen...");
    return { token: await vernieuwToken(a), aanvraag: a };
  }
  return { token: a.tesla_access_token, aanvraag: a };
}

/** Het CA-certificaat dat de wagen moet vertrouwen (eigen CA of Let's Encrypt-keten). */
export function certificaatKeten() {
  for (const naam of ["ca.pem", "fullchain.pem"]) {
    const pad = join(WORTEL, "certs", naam);
    if (existsSync(pad)) return readFileSync(pad, "utf8");
  }
  throw new Error("certs/ca.pem of certs/fullchain.pem niet gevonden. Maak eerst het certificaat aan (bash scripts/maak-certificaat.sh <host>).");
}
