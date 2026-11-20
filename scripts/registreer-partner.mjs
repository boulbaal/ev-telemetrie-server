// Eenmalige partner-registratie bij Tesla (per regio).
// Vereist dat de publieke sleutel bereikbaar is op:
//   https://<TESLA_DOMAIN>/.well-known/appspecific/com.tesla.3p.public-key.pem
// en dat TESLA_CLIENT_ID / TESLA_CLIENT_SECRET / TESLA_DOMAIN in de omgeving staan.
// Het client-secret hoort niet in .env van de server; geef het enkel mee voor dit
// eenmalige commando:
//
//   TESLA_CLIENT_ID=... TESLA_CLIENT_SECRET=... TESLA_DOMAIN=evbatterymotorservice.eu \
//     node scripts/registreer-partner.mjs
//
// Scopes: TESLA_SCOPES (standaard "openid offline_access vehicle_device_data").

const REGION = process.env.TESLA_REGION || "eu";
const BASE = REGION === "na"
  ? "https://fleet-api.prd.na.vn.cloud.tesla.com"
  : "https://fleet-api.prd.eu.vn.cloud.tesla.com";
const AUTH_TOKEN = "https://auth.tesla.com/oauth2/v3/token";

const clientId = process.env.TESLA_CLIENT_ID;
const clientSecret = process.env.TESLA_CLIENT_SECRET;
const domain = process.env.TESLA_DOMAIN;
const scope = process.env.TESLA_SCOPES || "openid offline_access vehicle_device_data";

if (!clientId || !clientSecret || !domain) {
  console.error("Ontbrekend: TESLA_CLIENT_ID, TESLA_CLIENT_SECRET of TESLA_DOMAIN.");
  process.exit(1);
}

console.log("1) Publieke sleutel controleren op het domein...");
const keyUrl = `https://${domain}/.well-known/appspecific/com.tesla.3p.public-key.pem`;
try {
  const r = await fetch(keyUrl);
  if (!r.ok) throw new Error(`status ${r.status}`);
  const txt = await r.text();
  if (!txt.includes("BEGIN PUBLIC KEY")) throw new Error("geen geldige PEM gevonden");
  console.log("   OK:", keyUrl);
} catch (e) {
  console.error(`   FOUT: sleutel niet bereikbaar op ${keyUrl}: ${e.message}`);
  console.error("   Zet het sleutelbestand eerst online op dit domein (zie TESLA-APP.md) en probeer opnieuw.");
  process.exit(1);
}

console.log("2) Partner-token ophalen...");
const tokRes = await fetch(AUTH_TOKEN, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
    audience: BASE,
  }),
});
if (!tokRes.ok) {
  console.error("   FOUT partner-token:", tokRes.status, await tokRes.text());
  process.exit(1);
}
const token = (await tokRes.json()).access_token;
console.log("   OK");

console.log("3) Partner-account registreren op", domain, "...");
const regRes = await fetch(`${BASE}/api/1/partner_accounts`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ domain }),
});
console.log("   Antwoord:", regRes.status, await regRes.text());
if (!regRes.ok) process.exit(1);
console.log("\nKlaar. Het partner-account is geregistreerd voor regio", REGION, ".");
