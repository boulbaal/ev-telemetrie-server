// Zuivere hulpfuncties van de bridge (geen netwerk), zodat ze testbaar zijn.

/** Haalt de waarde uit een fleet-telemetry JSON-waarde. */
export function waardeUit(v) {
  // {"stringValue":"x"} | {"doubleValue":1.2} | {"intValue":3} | {"booleanValue":true} | enum als string
  if (v == null || typeof v !== "object") return v;
  for (const k of ["doubleValue", "floatValue", "intValue", "longValue", "booleanValue", "stringValue"]) {
    if (k in v) return v[k];
  }
  return JSON.stringify(v);
}

/**
 * Ontleedt een MQTT-topic van fleet-telemetry.
 *   telemetry/<VIN>/v/<Veld>  -> { vin, soort: "v", veld }
 *   telemetry/<VIN>/alerts[/<naam>/current|history]  -> { vin, soort: "alerts", naam?, variant? }
 *   telemetry/<VIN>/errors[/<naam>]                   -> { vin, soort: "errors", naam? }
 */
export function ontleedTopic(topic) {
  const d = String(topic).split("/");
  if (d.length < 3 || d[0] !== "telemetry") return null;
  const vin = d[1];
  if (!/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) return null;
  if (d[2] === "v" && d[3]) return { vin: vin.toUpperCase(), soort: "v", veld: d[3] };
  if (d[2] === "alerts" || d[2] === "errors") {
    const uit = { vin: vin.toUpperCase(), soort: d[2] };
    if (d[3]) uit.naam = d[3];
    if (d[2] === "alerts" && d[4]) uit.variant = d[4];
    return uit;
  }
  return null;
}

/** Zet een MQTT-bericht om naar één meting voor de site. */
export function maakMeting(topic, payload, nu = new Date()) {
  const t = ontleedTopic(topic);
  if (!t || t.soort !== "v") return null;
  let waarde;
  let gemeten_op = nu.toISOString();
  try {
    const j = JSON.parse(payload);
    waarde = waardeUit(j);
    // Sommige payloads bevatten een tijdstempel; neem die als hij geldig is.
    const ts = j?.createdAt ?? j?.timestamp;
    if (ts) {
      const d = new Date(ts);
      if (!Number.isNaN(d.getTime())) gemeten_op = d.toISOString();
    }
  } catch {
    waarde = String(payload);
  }
  if (waarde === undefined || waarde === null) return null;
  return { vin: t.vin, signaal: t.veld, waarde, gemeten_op };
}

/** Eenvoudige batch-buffer: verzamelt metingen en geeft ze in stukken van max N terug. */
export class Buffer {
  constructor(max = 200) {
    this.max = max;
    this.items = [];
  }
  voegToe(m) {
    if (m) this.items.push(m);
    return this.items.length >= this.max;
  }
  get lengte() { return this.items.length; }
  neem() {
    const uit = this.items.slice(0, this.max);
    this.items = this.items.slice(this.max);
    return uit;
  }
}

/** Tijdstempel uit fleet-telemetry (ISO-tekst, epoch, of {seconds}) naar ISO; null als onbruikbaar. */
export function tijdUit(v) {
  if (v == null || v === "") return null;
  let d;
  if (typeof v === "object" && v !== null && "seconds" in v) d = new Date(Number(v.seconds) * 1000 + Math.round(Number(v.nanos ?? 0) / 1e6));
  else if (typeof v === "number") d = new Date(v > 1e12 ? v : v * 1000);
  else d = new Date(String(v));
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000) return null;
  return d.toISOString();
}

/**
 * Zet een alert- of error-bericht van fleet-telemetry om naar een "melding" voor de site.
 *   alerts: {"Name","StartedAt","EndedAt","Audiences"}            -> soort "alert"
 *   errors: {"Name","Body","Tags":{"field_name",...},"CreatedAt"}  -> soort "telemetriefout"
 * Geeft null bij onbruikbare berichten. "history"-berichten van alerts worden genegeerd
 * (de "current"-variant bevat dezelfde melding; dubbels vermijden).
 */
export function maakMelding(topic, payload, nu = new Date()) {
  const t = ontleedTopic(topic);
  if (!t || (t.soort !== "alerts" && t.soort !== "errors")) return null;
  if (t.variant === "history") return null;
  let j = null;
  try { j = JSON.parse(String(payload)); } catch { j = null; }
  const lijst = Array.isArray(j) ? j : Array.isArray(j?.alerts) ? j.alerts : Array.isArray(j?.errors) ? j.errors : [j];
  const uit = [];
  for (const x of lijst) {
    if (t.soort === "alerts") {
      const naam = String(x?.Name ?? x?.name ?? t.naam ?? "").trim();
      if (!naam) continue;
      const aud = x?.Audiences ?? x?.audiences ?? [];
      uit.push({
        vin: t.vin, naam, soort: "alert", bron: "telemetrie",
        gestart_op: tijdUit(x?.StartedAt ?? x?.startedAt) ?? nu.toISOString(),
        beeindigd_op: tijdUit(x?.EndedAt ?? x?.endedAt),
        doelgroepen: (Array.isArray(aud) ? aud : [aud]).map((a) => String(a).toLowerCase().replace(/_/g, "-")).filter(Boolean),
        detail: null,
      });
    } else {
      const tags = x?.Tags ?? x?.tags ?? {};
      const veld = tags?.field_name ?? null;
      const naam = veld ? `veld:${veld}` : String(x?.Name ?? x?.name ?? t.naam ?? "telemetriefout");
      uit.push({
        vin: t.vin, naam, soort: "telemetriefout", bron: "telemetrie",
        gestart_op: tijdUit(x?.CreatedAt ?? x?.createdAt) ?? nu.toISOString(),
        beeindigd_op: null, doelgroepen: [],
        detail: { body: String(x?.Body ?? x?.body ?? "").slice(0, 300), tags },
      });
    }
  }
  return uit.length ? uit : null;
}
