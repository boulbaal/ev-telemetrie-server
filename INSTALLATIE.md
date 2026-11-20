# Installatie — stap voor stap

Reken op ±1 uur. Volg de stappen in volgorde. Wat je nodig hebt:

- een Linux-server met Docker + Docker Compose (VPS aangeraden, zie stap 1);
- toegang tot het DNS-beheer van `evbatterymotorservice.eu`;
- toegang tot de Tesla-ontwikkelaarsapp (developer.tesla.com) en tot de
  secrets van het websiteproject (Lovable). **Alle geheimen maak je zelf nieuw
  aan** (zie stap 4 en "Nieuwe geheimen"); er worden geen oude doorgegeven.
- beheerdersrechten op de website (voor de instellingen in stap 7).

---

## Stap 1 — Server kiezen

**Aangeraden: een kleine VPS** (1 vCPU, 1–2 GB RAM, 10 GB schijf; ± € 4–6/maand,
bv. Hetzner, OVH of Contabo, liefst in de EU). Voordelen: een vast publiek
IP-adres, 24/7 aan, en geen router om aan te passen.

**Thuis kan ook** (zo draaide het tijdens de test), maar dan moet de pc altijd
aan staan, heb je een router met port forwarding nodig, en verandert het
publieke IP soms.

Op de server:

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git openssl nodejs
sudo usermod -aG docker $USER      # daarna opnieuw inloggen
git clone <deze-repo> ev-telemetrie-server && cd ev-telemetrie-server
```

(`nodejs` is enkel nodig voor de tests en de handmatige scripts; versie 20 of hoger.)

## Stap 2 — DNS

De wagens verbinden met een vaste hostnaam. Tesla eist dat die onder het
**geregistreerde partnerdomein** valt (`evbatterymotorservice.eu`, zie
TESLA-APP.md), anders weigert Tesla de configuratie met *"hostname domain does
not match with partner account"*.

In het DNS-beheer van `evbatterymotorservice.eu` (nu bij Wix):

| Type | Naam | Waarde |
|---|---|---|
| A | `telemetrie` | publiek IPv4-adres van de server |

Controle (na enkele minuten):
https://dns.google/resolve?name=telemetrie.evbatterymotorservice.eu&type=A

Thuis met een wisselend IP-adres? Gebruik dan DuckDNS en zet een **CNAME**
`telemetrie` → `<naam>.duckdns.org`.

## Stap 3 — Poort 4433 openzetten

De wagens verbinden via **TCP 4433** (TLS).

- **VPS:** firewall openzetten, bv. `sudo ufw allow 4433/tcp`. Kijk ook bij de
  provider of er een extra firewall in het webpaneel staat.
- **Thuis:** in de router *port forwarding* TCP 4433 → het lokale IP van de pc.
  Geef de pc een vast lokaal IP (DHCP-reservering). Telenet: Expertinstellingen →
  Port forwarding.

Andere poorten hoeven niet open. De proxy (4443) luistert alleen op 127.0.0.1;
mosquitto is enkel intern.

## Stap 4 — Geheimen en .env (alles nieuw)

```bash
cp .env.example .env
openssl rand -hex 32                     # -> nieuw TELEMETRIE_SECRET
nano .env        # SITE_URL, TELEMETRIE_SECRET, TESLA_CLIENT_ID, TELEMETRIE_HOST, TELEMETRIE_POORT
mkdir -p keys
openssl ecparam -name prime256v1 -genkey -noout -out keys/private-key.pem
openssl ec -in keys/private-key.pem -pubout -out keys/public-key.pem
chmod 600 .env keys/private-key.pem
```

Zie hieronder **"Nieuwe geheimen — wat er nog moet gebeuren"**: een nieuw
sleutelpaar en een nieuw TELEMETRIE_SECRET moeten ook op de website en bij
Tesla aangepast worden.

- `TELEMETRIE_SECRET` moet **exact gelijk** zijn aan het secret
  `TELEMETRIE_SECRET` in het websiteproject (Lovable → Settings → Secrets).
  Verschillen ze, dan geeft de website **401** op elke oproep.
- `SITE_URL` is het **gepubliceerde** adres van de website, niet de preview van
  Lovable. Die is afgeschermd.
- `keys/private-key.pem` is de private sleutel waarvan de publieke tegenhanger
  op de website staat (`/.well-known/appspecific/com.tesla.3p.public-key.pem`).
  Een andere sleutel = de wagen kent hem niet = `missing_key`.

## Stap 5 — Certificaat

```bash
bash scripts/maak-certificaat.sh telemetrie.evbatterymotorservice.eu
```

Dit maakt in `certs/`:

- `ca.pem` — een eigen CA. Die gaat mee in de configuratie naar Tesla; de
  wagen vertrouwt daardoor ons certificaat.
- `fullchain.pem` + `privkey.pem` — voor de ontvanger.
- `proxy-cert.pem` + `proxy-key.pem` — voor de lokale proxy.

Er is geen Let's Encrypt nodig (Tesla aanvaardt een eigen CA), en ook geen
poort 80. Het servercertificaat is 2 jaar geldig. Daarna verwijder je de
server-bestanden en voer je hetzelfde commando opnieuw uit. Bewaar `ca-key.pem`!

Liever Let's Encrypt? Zet de `fullchain.pem` + `privkey.pem` van certbot in
`certs/` en verwijder `ca.pem`. De scripts nemen dan de keten als CA.

**Let op:** bij een nieuwe CA moeten lopende metingen opnieuw geconfigureerd
worden, want de oude configuratie op de wagen bevat de oude CA.

## Stap 6 — Starten

```bash
docker compose up -d --build
docker compose ps            # bridge, fleet-telemetry, mosquitto, poller, vehicle-command: "Up"
docker compose logs -f       # meekijken (Ctrl+C stopt enkel het meekijken)
```

Docker start alles vanzelf opnieuw na een herstart van de server
(`restart: unless-stopped`).

## Stap 7 — Website instellen

In het beheer van de website → **/admin/instellingen**:

- `telemetrie_host` = `telemetrie.evbatterymotorservice.eu`
- `telemetrie_poort` = `4433`
- `telemetrie_uren` = `24` (duur van een meting)
- `telemetrie_wakker_houden` = aan (wekt de wagen om de 10 min, niet onder 15 % SoC)

De website moet de routes uit **SITE-API.md** hebben. De testkopie heeft ze;
bij de overzetting naar de live site moeten ze mee.

## Stap 8 — Controleren

1. `docker compose logs poller` → elke minuut "geen taken" (of de wagens die hij
   aan- en uitzet). Bij de start ook: `woordenboek: … meldingen naar de site`.
2. `docker compose logs bridge` → "Verbonden met MQTT … → site: …".
3. Van buitenaf (bv. vanaf een andere pc of je gsm op 4G):
   ```bash
   openssl s_client -connect telemetrie.evbatterymotorservice.eu:4433 \
     -servername telemetrie.evbatterymotorservice.eu </dev/null | head
   ```
   Je moet het certificaat zien (CN = de hostnaam). "Connection refused" of een
   timeout betekent dat de poort of firewall (stap 3) niet in orde is.
4. Tests: `node --test scripts/*.test.mjs bridge/*.test.mjs` → alles groen.
5. Echte test: een diepe analyse aanvragen op de website met een eigen Tesla
   (zie TESLA-APP.md, "Wat de klant doet"). Binnen enkele minuten verschijnen
   de eerste metingen in het dossier (tabblad Live meting / Dashboard_Daoud).

## Nieuwe geheimen — wat er nog moet gebeuren

De vorige server wordt niet overgenomen; alle geheimen worden opnieuw
aangemaakt. Na stap 4 en 5:

1. **TELEMETRIE_SECRET**: dezelfde nieuwe waarde zetten in het websiteproject
   (Lovable → Settings → Secrets → `TELEMETRIE_SECRET`) en de website
   opnieuw publiceren.
2. **Sleutelpaar van de Tesla-app**:
   - `keys/public-key.pem` op de website zetten op
     `https://evbatterymotorservice.eu/.well-known/appspecific/com.tesla.3p.public-key.pem`
     (vervangt de oude publieke sleutel);
   - de partnerregistratie opnieuw doen (zie TESLA-APP.md, "Partnerdomein"), zodat
     Tesla de nieuwe sleutel kent;
   - gevolg: wagens met een **virtuele sleutel** (Model 3/Y, S/X vanaf 2021)
     moeten de sleutel **opnieuw toevoegen** via
     `https://www.tesla.com/_ak/evbatterymotorservice.eu`. Oudere S/X met de
     schakelaar in de wagen hebben geen sleutel nodig.
3. **Client-ID / client-secret**: in developer.tesla.com bij de app. Een nieuw
   client-secret kan daar ook aangemaakt worden ("regenerate"); zet het dan
   ook in de secrets van de website (`TESLA_CLIENT_SECRET`).
4. **Certificaten**: worden in stap 5 nieuw gemaakt (eigen CA). Configuraties
   die nog op wagens staan, wijzen naar de oude CA: start elke meting opnieuw.
5. Oude server uitzetten en de oude geheimen als ongeldig beschouwen.

## Verhuizen van de oude server

1. Nieuwe server opzetten (stappen 1–6) met nieuwe geheimen (zie hierboven).
   Wacht tot er geen meting meer loopt op de oude server.
2. DNS-record `telemetrie` naar het nieuwe IP.
3. Op de oude server `docker compose down` **pas** nadat er geen meting meer
   loopt (geen dossiers met telemetriestatus "actief").
