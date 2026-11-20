// Bridge: leest telemetriesignalen van de MQTT-broker en stuurt ze in batches
// naar de website (Lovable): POST /api/telemetrie/metingen.
// Meldingen van de wagen (alerts) en telemetriefouten gaan naar
// /api/telemetrie/meldingen (gekoppeld aan de aanvraag via de VIN). Bestaat die
// route nog niet (404), dan als logregel naar /api/telemetrie/log.
//
// Omgeving (.env / docker-compose):
//   MQTT_URL           mqtt://mosquitto:1883
//   SITE_URL           https://<site>            (zonder slash op het einde)
//   TELEMETRIE_SECRET  gedeeld geheim met de site
import mqtt from "mqtt";
import { maakMeting, maakMelding, ontleedTopic, Buffer } from "./lib.mjs";

const MQTT_URL = process.env.MQTT_URL || "mqtt://localhost:1883";
const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");
const SECRET = process.env.TELEMETRIE_SECRET;
const FLUSH_MS = parseInt(process.env.FLUSH_MS || "5000", 10);

if (!SITE_URL || !SECRET) {
  console.error("SITE_URL / TELEMETRIE_SECRET ontbreken (zet ze in .env)");
  process.exit(1);
}

async function post(pad, body) {
  const res = await fetch(`${SITE_URL}${pad}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${pad} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json().catch(() => ({}));
}

const buffer = new Buffer(200);
let bezig = false;

async function flush() {
  if (bezig || buffer.lengte === 0) return;
  bezig = true;
  try {
    while (buffer.lengte > 0) {
      const batch = buffer.neem();
      try {
        const r = await post("/api/telemetrie/metingen", { metingen: batch });
        console.log(`→ ${batch.length} metingen verstuurd (ingevoegd ${r.ingevoegd ?? "?"}, genegeerd ${r.genegeerd ?? "?"})`);
      } catch (e) {
        console.error("versturen faalde, batch gaat terug in de wachtrij:", e.message);
        buffer.items = batch.concat(buffer.items).slice(-5000); // nooit onbeperkt groeien
        break;
      }
    }
  } finally {
    bezig = false;
  }
}
setInterval(flush, FLUSH_MS);

// ---- Meldingen (alerts + telemetriefouten) ----
const meldBuffer = new Buffer(100);
let meldBezig = false;
let meldRouteOntbreektTot = 0;
async function flushMeldingen() {
  if (meldBezig || meldBuffer.lengte === 0) return;
  meldBezig = true;
  try {
    while (meldBuffer.lengte > 0) {
      const batch = meldBuffer.neem();
      if (Date.now() < meldRouteOntbreektTot) {
        for (const m of batch) {
          post("/api/telemetrie/log", { niveau: m.soort === "alert" ? "warn" : "error", detail: `${m.vin} ${m.soort}: ${m.naam}` }).catch(() => {});
        }
        continue;
      }
      try {
        const r = await post("/api/telemetrie/meldingen", { meldingen: batch });
        console.log(`→ ${batch.length} meldingen verstuurd (ingevoegd ${r.ingevoegd ?? "?"}, genegeerd ${r.genegeerd ?? "?"})`);
      } catch (e) {
        if (/-> 404/.test(e.message)) {
          meldRouteOntbreektTot = Date.now() + 10 * 60 * 1000;
          console.error("site heeft nog geen /api/telemetrie/meldingen; meldingen gaan 10 min als logregel");
          meldBuffer.items = batch.concat(meldBuffer.items);
          continue;
        }
        console.error("meldingen versturen faalde, terug in de wachtrij:", e.message);
        meldBuffer.items = batch.concat(meldBuffer.items).slice(-1000);
        break;
      }
    }
  } finally {
    meldBezig = false;
  }
}
setInterval(flushMeldingen, FLUSH_MS);

const client = mqtt.connect(MQTT_URL);
client.on("connect", () => {
  console.log("Verbonden met MQTT:", MQTT_URL, "→ site:", SITE_URL);
  client.subscribe("telemetry/#");
});

client.on("message", async (topic, payload) => {
  try {
    const t = ontleedTopic(topic);
    if (!t) return;
    if (t.soort === "v") {
      if (buffer.voegToe(maakMeting(topic, payload.toString()))) flush();
    } else {
      const meldingen = maakMelding(topic, payload.toString());
      if (!meldingen) return;
      for (const m of meldingen) {
        console.log(`${m.soort} voor ${m.vin}: ${m.naam}`);
        meldBuffer.voegToe(m);
      }
      flushMeldingen();
    }
  } catch (e) {
    console.error("Verwerkingsfout:", e.message);
  }
});

client.on("error", (e) => console.error("MQTT-fout:", e.message));
