// Zuivere beslislogica van de poller, zonder netwerk, zodat ze testbaar is.
//
// Een "taak" is een aanvraag van type 'diep' zoals de site ze teruggeeft:
//   { aanvraag_id, vin, telemetrie_status, telemetrie_tot, gestart_op, ... }
//
// Mogelijke acties:
//   - { actie: "aanzetten" }   sleutel staat erop volgens de klant -> configureren
//   - { actie: "uitzetten" }   meetperiode voorbij -> configuratie verwijderen
//   - { actie: "niets" }       actief en nog binnen de periode

export function beslis(taak, nu = new Date()) {
  const status = taak.telemetrie_status;
  if (status === "sleutel_toegevoegd") return { actie: "aanzetten" };
  if (status === "actief") {
    const tot = taak.telemetrie_tot ? new Date(taak.telemetrie_tot) : null;
    if (tot && !Number.isNaN(tot.getTime()) && nu >= tot) return { actie: "uitzetten" };
    return { actie: "niets" };
  }
  return { actie: "niets" };
}

/**
 * Welke meldingen (alerts) de wagen moet meesturen. Tesla stuurt alleen alerts
 * waarvan de doelgroep in alert_types staat:
 *   customer    = zichtbaar op het scherm in de wagen
 *   service     = nuttig voor diagnose
 *   service-fix = moet hersteld worden (voor de garage het belangrijkste)
 */
export const ALERT_TYPES = ["service", "service-fix", "customer"];

/** Bouwt de body voor fleet_telemetry_config. */
export function configBody(vin, instellingen, caPem, velden, alertTypes = ALERT_TYPES) {
  const config = {
    hostname: instellingen.telemetrie_host,
    port: Number(instellingen.telemetrie_poort) || 4433,
    ca: caPem,
    fields: velden,
  };
  if (alertTypes?.length) config.alert_types = alertTypes;
  return { vins: [vin], config };
}

/**
 * Leest het antwoord van fleet_telemetry_config en vertaalt het naar een
 * resultaat: { ok: true } of { ok: false, reden, uitleg, definitief }.
 * definitief = true betekent: heeft geen zin om het te blijven proberen.
 */
export function beoordeelConfigAntwoord(status, json) {
  if (status === 401) return { ok: false, reden: "token_verlopen", uitleg: "Tesla-token verlopen", definitief: false };
  if (status < 200 || status >= 300) {
    return { ok: false, reden: `http_${status}`, uitleg: `Tesla antwoordde ${status}`, definitief: status >= 400 && status !== 429 && status < 500 };
  }
  const geweigerd = json?.response?.skipped_vehicles ?? {};
  for (const [reden, vins] of Object.entries(geweigerd)) {
    if (Array.isArray(vins) && vins.length) {
      const uitleg = {
        missing_key: "de sleutel staat nog niet op de wagen",
        unsupported_hardware: "deze wagen ondersteunt geen telemetrie op afstand (oudere Model S/X zonder Intel-computer, of firmware te oud)",
        unsupported_firmware: "de firmware van de wagen is te oud",
        max_configs: "de wagen heeft al het maximum aantal configuraties",
      }[reden] ?? reden;
      const definitief = reden === "unsupported_hardware" || reden === "unsupported_firmware" || reden === "max_configs";
      return { ok: false, reden, uitleg, definitief };
    }
  }
  return { ok: true };
}

/** Na hoeveel mislukte pogingen (bv. missing_key) geven we op? */
export const MAX_POGINGEN = 12; // bij 5 min interval = 1 uur

export const VELDEN = {
  // --- batterij (sinds 2024.26) ---
  Soc: { interval_seconds: 60 },
  EnergyRemaining: { interval_seconds: 60 },
  RatedRange: { interval_seconds: 60 },
  EstBatteryRange: { interval_seconds: 60 },
  PackVoltage: { interval_seconds: 60 },
  PackCurrent: { interval_seconds: 60 },
  BrickVoltageMax: { interval_seconds: 60 },
  BrickVoltageMin: { interval_seconds: 60 },
  NumBrickVoltageMax: { interval_seconds: 300 },
  NumBrickVoltageMin: { interval_seconds: 300 },
  ModuleTempMax: { interval_seconds: 300 },
  ModuleTempMin: { interval_seconds: 300 },
  LifetimeEnergyUsed: { interval_seconds: 300 },
  Odometer: { interval_seconds: 300 },
  // --- diagnose (diagnoselijst van de specialist) ---
  // Isolatie HV-bus <-> chassis in kΩ. Contactoren open (rust) = intern pakket,
  // contactoren dicht (rijden/laden) = totaal systeem; de site splitst dat.
  IsolationResistance: { interval_seconds: 60 },
  // "event"-velden: worden enkel verstuurd als de waarde verandert.
  // BMSState kwam op 5–6/11 niet door; de andere event-velden testen of deze
  // wagen überhaupt event-velden stuurt.
  BMSState: { interval_seconds: 1 },
  Hvil: { interval_seconds: 1 },
  DiStateR: { interval_seconds: 1 },
  DiStateF: { interval_seconds: 1 },
  DetailedChargeState: { interval_seconds: 1 },
  Gear: { interval_seconds: 1 },
  BmsFullchargecomplete: { interval_seconds: 1 },
};

/** Velden die pas bestaan vanaf firmware 2026.32 (anders meldt de wagen een fout per veld). */
export const VELDEN_2026_32 = {
  NominalFullPackEnergyKwh: { interval_seconds: 300 },
  BrickSocMinPercent: { interval_seconds: 60 },
};

/** true als firmware ("2026.20.6") minstens versie ("2026.32") is; onbekend -> false. */
export function firmwareMinstens(firmware, versie) {
  if (!firmware) return false;
  const a = String(firmware).split(/[.\s]/).map((x) => parseInt(x, 10));
  const b = String(versie).split(".").map((x) => parseInt(x, 10));
  if (a.some((x, i) => i < b.length && Number.isNaN(x))) return false;
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    if (x !== b[i]) return x > b[i];
  }
  return true;
}

/** De velden voor één wagen, afhankelijk van zijn firmware. */
export function veldenVoor(firmware) {
  return firmwareMinstens(firmware, "2026.32") ? { ...VELDEN, ...VELDEN_2026_32 } : { ...VELDEN };
}

/**
 * GET /api/1/vehicles/{vin}/recent_alerts -> meldingen voor de site.
 * Verwacht vorm: { response: { recent_alerts: [{ name, time, audience: [...], user_text }] } };
 * defensief, want Tesla documenteert het antwoord niet in detail.
 */
export function meldingenUitRecentAlerts(json, vin) {
  const r = json?.response;
  const lijst = Array.isArray(r?.recent_alerts) ? r.recent_alerts : Array.isArray(r) ? r : Array.isArray(json?.recent_alerts) ? json.recent_alerts : [];
  const uit = [];
  for (const a of lijst) {
    const naam = String(a?.name ?? a?.Name ?? "").trim();
    if (!naam) continue;
    const t = a?.time ?? a?.started_at ?? a?.StartedAt;
    const d = t ? new Date(t) : null;
    const aud = a?.audience ?? a?.audiences ?? [];
    uit.push({
      vin, naam, soort: "alert", bron: "recent_alerts",
      gestart_op: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null,
      beeindigd_op: null,
      doelgroepen: (Array.isArray(aud) ? aud : [aud]).map((x) => String(x).toLowerCase().replace(/_/g, "-")).filter(Boolean),
      detail: a?.user_text ? { user_text: String(a.user_text).slice(0, 300) } : null,
    });
  }
  return uit;
}

/**
 * GET /api/1/vehicles/{vin}/fleet_telemetry_errors -> meldingen (soort "telemetriefout").
 * Verwacht vorm: { response: { fleet_telemetry_errors: [{ name, error, vin }] } }; defensief.
 */
export function meldingenUitTelemetrieFouten(json, vin) {
  const r = json?.response;
  const lijst = Array.isArray(r?.fleet_telemetry_errors) ? r.fleet_telemetry_errors : Array.isArray(r) ? r : [];
  return lijst.map((e) => {
    const tekst = String(e?.error ?? e?.message ?? "").slice(0, 300);
    const veld = tekst.match(/\b([A-Z][A-Za-z0-9]+)\b/)?.[1];
    return {
      vin, naam: String(e?.name ?? (veld ? `veld:${veld}` : "telemetriefout")).slice(0, 120),
      soort: "telemetriefout", bron: "fleet_telemetry_errors",
      gestart_op: e?.created_at ? new Date(e.created_at).toISOString() : null,
      beeindigd_op: null, doelgroepen: [], detail: { error: tekst },
    };
  });
}

/**
 * Wagen wakker houden tijdens een actieve meting.
 * Tesla stuurt geen telemetrie zodra de wagen slaapt; een wake_up om de
 * zoveel minuten houdt de stroom gaande. Kost de klant ±2–4 % SoC per 24 u,
 * dus uit te zetten via de instelling telemetrie_wakker_houden en nooit
 * onder een minimum-SoC.
 *
 * @param {object} o
 * @param {"online"|"asleep"|"offline"|string|null} o.state  status volgens Tesla
 * @param {boolean} o.wakkerHouden   instelling van de site
 * @param {number|null} o.laatsteWakeMs  tijdstip (ms) van de laatste wake_up, of null
 * @param {number} o.nuMs
 * @param {number|null} o.laatsteSoc  laatst gemeten SoC (%), of null als onbekend
 * @returns {{ wekken: boolean, reden: string }}
 */
export const WAKE_INTERVAL_MS = 10 * 60 * 1000;
export const MIN_SOC_WAKKER = 15;

export function beslisWagen({ state, wakkerHouden, laatsteWakeMs, nuMs, laatsteSoc }) {
  if (!wakkerHouden) return { wekken: false, reden: "wakker houden staat uit" };
  if (state === "online") return { wekken: false, reden: "wagen is online" };
  if (state === "offline") return { wekken: false, reden: "wagen is offline (geen internet) — wake-up heeft geen zin" };
  if (laatsteSoc != null && laatsteSoc < MIN_SOC_WAKKER) return { wekken: false, reden: `SoC ${laatsteSoc} % onder minimum ${MIN_SOC_WAKKER} %` };
  if (laatsteWakeMs != null && nuMs - laatsteWakeMs < WAKE_INTERVAL_MS) return { wekken: false, reden: "laatste wake-up is minder dan 10 min geleden" };
  return { wekken: true, reden: state === "asleep" ? "wagen slaapt" : `status ${state ?? "onbekend"}` };
}

/**
 * Commando's die het beheer mag sturen (enkel op vraag van de klant).
 * Sleutel = naam in de site; waarde = pad bij Tesla (via de proxy) + hoe de parameters worden doorgegeven.
 */
export const COMMANDOS = {
  wake_up:            { pad: "wake_up",                       methode: "POST", body: () => undefined, isCommand: false },
  laden_starten:      { pad: "command/charge_start",          methode: "POST", body: () => ({}) },
  laden_stoppen:      { pad: "command/charge_stop",           methode: "POST", body: () => ({}) },
  laadlimiet:         { pad: "command/set_charge_limit",      methode: "POST", body: (p) => ({ percent: Math.min(100, Math.max(50, Number(p?.percent) || 80)) }) },
  klimaat_aan:        { pad: "command/auto_conditioning_start", methode: "POST", body: () => ({}) },
  klimaat_uit:        { pad: "command/auto_conditioning_stop",  methode: "POST", body: () => ({}) },
  knipperen:          { pad: "command/flash_lights",          methode: "POST", body: () => ({}) },
  claxon:             { pad: "command/honk_horn",             methode: "POST", body: () => ({}) },
};

/** Samengestelde commando's: meerdere stappen na elkaar (bv. "verbinding feedback" = knipperen + claxon). */
export const SAMENGESTELD = {
  verbinding_feedback: ["knipperen", "claxon"],
};

/** Lijst van aanroepen voor een commando (1 of meer stappen); null als onbekend. */
export function commandoStappen(commando, params) {
  const namen = SAMENGESTELD[commando] ?? [commando];
  const stappen = namen.map((n) => commandoAanroep(n, params));
  return stappen.every(Boolean) ? stappen : null;
}

/** Vertaalt een commando-taak van de site naar een HTTP-aanroep; null als onbekend. */
export function commandoAanroep(commando, params) {
  const c = COMMANDOS[commando];
  if (!c) return null;
  return { pad: `api/1/vehicles/{vin}/${c.pad}`, methode: c.methode, body: c.body(params) };
}

/** Leest het antwoord van een command-endpoint: { ok, uitleg }. */
export function beoordeelCommandoAntwoord(status, json) {
  if (status === 401) return { ok: false, uitleg: "Tesla-token verlopen", tokenVerlopen: true };
  if (status === 403) return { ok: false, uitleg: "geen toestemming: de klant moet opnieuw inloggen en commando's toestaan" };
  if (status === 408) return { ok: false, uitleg: "wagen slaapt of is onbereikbaar (408)" };
  if (status < 200 || status >= 300) return { ok: false, uitleg: `Tesla antwoordde ${status}${json?.error ? `: ${String(json.error).slice(0, 120)}` : ""}` };
  const r = json?.response;
  if (r && typeof r === "object" && "result" in r && r.result === false) return { ok: false, uitleg: `geweigerd: ${r.reason || "onbekend"}` };
  return { ok: true, uitleg: r?.reason || "uitgevoerd" };
}
