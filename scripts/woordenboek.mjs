// Tesla's woordenboek van meldingen (alerts): naam -> beschrijving, gevolg, doelgroep.
// Bron: https://fleet-api-files-prd.tesla.com/alert_dictionary.csv (publiek, ±8 MB, >20.000 regels).
// We houden enkel de meldingen die over batterij, aandrijving en laden gaan en sturen die
// naar de site, zodat het beheer bij elke melding de uitleg van Tesla kan tonen.
import { createHash } from "node:crypto";

export const WOORDENBOEK_URL = "https://fleet-api-files-prd.tesla.com/alert_dictionary.csv";

/** Voorvoegsels die relevant zijn voor de batterij-/aandrijvingsdiagnose. */
export const RELEVANT = /^(BMS|BMSSEMI|DI|DIF|DIR|DIREL|DIRER|DIS|HVP|HVBATT\d?|HVPACK\d?|HVLINK|PCS\d?[LR]?|CP|CHG|CHGS|DCDC|FC|UMC|VCBATT\d?|PM|PMF|PMR)_/;

/** Eenvoudige CSV-parser (RFC 4180: aanhalingstekens, dubbele "" en regeleinden in velden). */
export function parseCsv(tekst) {
  const rijen = [];
  let rij = [], veld = "", tussen = false;
  for (let i = 0; i < tekst.length; i++) {
    const c = tekst[i];
    if (tussen) {
      if (c === '"') { if (tekst[i + 1] === '"') { veld += '"'; i++; } else tussen = false; }
      else veld += c;
    } else if (c === '"') tussen = true;
    else if (c === ",") { rij.push(veld); veld = ""; }
    else if (c === "\n") { rij.push(veld); rijen.push(rij); rij = []; veld = ""; }
    else if (c !== "\r") veld += c;
  }
  if (veld !== "" || rij.length) { rij.push(veld); rijen.push(rij); }
  return rijen;
}

const kort = (s, n = 400) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return !t || t === "Not Available" ? null : t.slice(0, n);
};

/** CSV-tekst -> lijst items voor de site (enkel relevante meldingen). */
export function woordenboekItems(tekst, filter = RELEVANT) {
  const rijen = parseCsv(tekst);
  if (!rijen.length) return [];
  const kop = rijen[0].map((k) => k.trim());
  const idx = (n) => kop.indexOf(n);
  const i = {
    naam: idx("SignalName"), voorwaarde: idx("Condition"), einde: idx("ClearCondition"), beschrijving: idx("Description"),
    gevolg: idx("PotentialImpact"), klant1: idx("CustomerFacingMessage1"), klant2: idx("CustomerFacingMessage2"),
    doelgroepen: idx("Audiences"), modellen: idx("Models"),
  };
  if (i.naam < 0) return [];
  const uit = [];
  for (const r of rijen.slice(1)) {
    const naam = (r[i.naam] ?? "").trim();
    if (!naam || !filter.test(naam)) continue;
    const beschrijving = kort(r[i.beschrijving]);
    uit.push({
      naam,
      beschrijving: beschrijving && beschrijving !== naam ? beschrijving : null,
      voorwaarde: kort(r[i.voorwaarde]),
      einde: kort(r[i.einde]),
      gevolg: kort(r[i.gevolg]),
      klanttekst: [kort(r[i.klant1], 200), kort(r[i.klant2], 200)].filter(Boolean).join(" — ") || null,
      doelgroepen: String(r[i.doelgroepen] ?? "").split(";").map((x) => x.trim().toLowerCase()).filter(Boolean),
      modellen: String(r[i.modellen] ?? "").split(";").map((x) => x.trim()).filter(Boolean),
    });
  }
  return uit;
}

export function hash(tekst) {
  return createHash("sha256").update(tekst).digest("hex").slice(0, 16);
}

/** Downloadt het woordenboek; geeft { hash, items } of gooit een fout. */
export async function haalWoordenboek(url = WOORDENBOEK_URL, fetchFn = fetch) {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`woordenboek ${res.status}`);
  const tekst = await res.text();
  return { hash: hash(tekst), items: woordenboekItems(tekst) };
}
