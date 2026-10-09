# Aurex | Development

Discord bot + webdashboard voor een dev shop server: **tickets**, **welkomstbericht**,
**verificatie** en **regels** — allemaal in te stellen via zowel Discord slash
commands als het dashboard.

## Features

- **🎫 Tickets** — configureerbaar paneel met meerdere ticket-types (bv. Bestelling,
  Support, Klacht), claim/close-knoppen, transcript-logging, per-type categorie & rol.
- **👋 Welkomstbericht** — bericht + embed + optionele auto-rol + optionele DM
  zodra iemand joint. Placeholders: `{user}`, `{username}`, `{server}`, `{membercount}`.
- **🔐 Verificatie** — één-klik verify-knop die direct een ingestelde rol toekent
  (of meerdere rollen tegelijk). Geen account-koppeling of code nodig.
- **📜 Regels** — configureerbare regels-embed, met `/rules-send` te (her)plaatsen;
  nogmaals uitvoeren werkt het bestaande bericht bij in plaats van te spammen.
- **🛒 Webshop** — publieke `/shop`-pagina met producten, login met Discord, en echte
  betalingen via een eigen checkout (Mollie), met bestellingen en betaalstatussen in het dashboard. Beheer producten (prijs, versie, changelog) via
  het dashboard; met één klik op "Stuur update" krijgt iedereen die het product
  gekocht heeft een DM met de nieuwe versie. Zie "Webshop instellen" hieronder.
- **Dashboard** — login met Discord, kies een server waar je "Manage Server" rechten
  hebt, en stel alles hierboven in met live preview.

## Productfoto's (meerdere foto's, cover, bladeren)

- **Discord:** `/product add`, `/product update` en `/product fotos` hebben de velden `foto1` t/m `foto15`.
  `foto1` is de **cover**; de volgorde van de velden is de volgorde in de shop.
  Foto's bij `/product update` worden **achteraan toegevoegd** (de cover blijft). Alle foto's
  vervangen kan met `/product fotos` (foto1 wordt de nieuwe cover).
- **Dashboard → Webshop:** kies meerdere foto's tegelijk (klik een foto om hem de cover te
  maken). Bij bestaande producten kun je foto's toevoegen, verwijderen of "Maak cover" kiezen.
- Foto's (PNG/JPG/WEBP/GIF, max 15 per product, max 8 MB per foto) staan in de database en
  worden via `PUBLIC_URL` uitgeleverd — **`PUBLIC_URL` moet dus ingesteld zijn** (de Vercel-shop
  laadt de foto's van daar). Oude foto-links blijven werken en komen achter de uploads.
- **Shop-site:** pijltjes op de hoofdfoto, swipe op mobiel, klik voor een grote weergave met
  pijltjes / toetsenbord (← → Esc).

## Reviews, kortingscodes en bundels

- **Reviews:** alleen kopers (afgeronde aankoop) kunnen een review van 1-5 sterren + tekst achterlaten,
  één per product (opnieuw insturen werkt de review bij). Dat kan op de productpagina en via
  *Mijn aankopen*; de bestelbevestiging per DM nodigt er ook voor uit. Alle reviews staan op de
  aparte pagina **Reviews** (`#/reviews`) met filter per product. De gemiddelde score staat op de
  productkaarten, productpagina en in het Discord-overzichtskanaal. Het Discord-account wordt als
  naam getoond. Ongepaste reviews verwijder je in het dashboard (Webshop → Reviews).
- **Kortingscodes** (dashboard → Webshop → Kortingscodes): percentage of vast bedrag, optioneel
  maximaal aantal keer en einddatum. Elke koper kan een code één keer gebruiken; een code telt pas
  mee zodra er echt betaald is. 100% korting rekent zonder betaalprovider af.
- **Bundels** staan voorlopig uit (de bundelkorting is nog niet aangesloten op de nieuwe checkout).
- Een kortingscode hoef je nergens anders aan te maken: de server rekent de korting zelf uit
  (`api/utils/pricing.js`) en dat korting-bedrag is precies wat de klant bij Mollie betaalt.
- Na korting moet het totaal minimaal 0,50 zijn, of precies 0 (gratis).
- Labels op de kaarten: **Nieuw** (jonger dan 14 dagen), **Gratis**, **Bestseller** (meeste verkopen).
  Met de muis over een kaart zie je de tweede foto.
- Nieuwe tabellen (`reviews`, `bundles`, `discount_codes`) en kolommen worden bij het starten
  automatisch aangemaakt; er hoeft niets handmatig te gebeuren.

## Webshop & eigen checkout (Mollie)

De klant kiest producten op je eigen website, ziet een afrekenpagina (`#/checkout`) met productnaam,
prijs, aantal en totaalbedrag, en gaat vanaf daar naar de beveiligde betaalpagina van Mollie. Daarna
komt hij terug op een statuspagina (`#/order/<order-ID>`) die vanzelf bijwerkt.

**Flow**

1. `POST /store/checkout` — de server berekent het bedrag zelf (nooit uit de browser), legt de bestelling
   vast met een automatisch order-ID (`AX-YYMMDD-XXXXXX`, status *wachten op betaling*) en maakt de betaling
   aan bij Mollie. De browser krijgt alleen de betaal-link terug.
2. Mollie roept `POST <PUBLIC_URL>/store/payments/webhook` aan zodra de status verandert. De server vertrouwt de
   webhook niet blind: hij haalt de betaling zelf op bij Mollie (met de secret key) en controleert status én bedrag.
3. Bij *betaald* gebeurt precies één keer: aankoop afronden, kortingscode tellen en de bestel-DM met bestand
   versturen. Dubbele of gelijktijdige webhooks leveren dus nooit dubbel.
4. De statuspagina vraagt ook zelf (server-side, max. eens per 5 s) de status op, en een achtergrondtaak
   controleert elke 10 minuten openstaande bestellingen. Een gemiste webhook leidt dus niet tot een betaalde
   maar niet-geleverde bestelling.

**Betaalstatussen**: `Wachten op betaling` → `Betaald` · `Mislukt` (mislukt of verlopen) · `Geannuleerd`.

**Admin**: dashboard → tabblad **💳 Bestellingen** — omzet en aantallen per status, zoeken/filteren, detail met
producten, bedragen, betaalmethode, Mollie-ID en een betaallogboek, knop *Status bij Mollie controleren* en
CSV-export. Alleen toegankelijk met je Discord-login (Manage Server) of de bot-API-key.

**Instellen**

1. Maak een [Mollie](https://www.mollie.com)-account, ga naar **Developers → API keys** en zet de **test key**
   (`test_...`) in `MOLLIE_API_KEY` op Render (Environment). Zet `PUBLIC_URL` op je https-adres en
   `SHOP_ORIGIN` op de URL van de shop-site.
2. Activeer in Mollie de betaalmethodes die je wilt (iDEAL, creditcard, PayPal, ...).
3. Redeploy en doe een testbetaling (in testmodus kies je op de Mollie-pagina zelf de uitkomst:
   betaald / mislukt / geannuleerd / verlopen). Controleer dat de bestelling in het dashboard op *Betaald* springt
   en de DM binnenkomt.
4. Pas daarna de **live key** (`live_...`) invullen en je Mollie-profiel laten goedkeuren.

Producten hebben geen betaalprovider-ID meer nodig; alleen naam, prijs en bestand. Het oude Tebex-webhook-endpoint
(`/store/webhook`) blijft staan zodat bestellingen die nog bij Tebex openstonden kunnen afronden; het wordt niet
meer gebruikt voor nieuwe bestellingen.

## Projectstructuur

```
api/          Express API — auth, database, alle /config routes voor het dashboard
bot/          Discord bot — commands, event handlers, embed/permissie-helpers
public/       Statische dashboard front-end (vanilla HTML/CSS/JS)
start.js      Combined entry point (API + bot in 1 proces — zie hieronder)
```

## Snel starten

1. **Installeer dependencies**
   ```bash
   npm install
   ```

2. **Kopieer `.env.example` naar `.env`** en vul in:
   - `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` — uit het [Discord Developer Portal](https://discord.com/developers/applications)
   - `DISCORD_CLIENT_SECRET` + een redirect `<PUBLIC_URL>/auth/discord/callback` onder OAuth2
   - `API_KEY` — een willekeurige lange string (bot ↔ API authenticatie)
   - `SESSION_SECRET` — genereer met `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `PUBLIC_URL` — waar de app bereikbaar is (lokaal: `http://localhost:3000`)
   - Database: laat `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` leeg voor een lokaal
     SQLite-bestand, of vul ze in voor [Turso](https://turso.tech) (aanbevolen voor
     hosting op Render, omdat data dan niet verdwijnt bij een redeploy).

3. **Zorg dat de bot de juiste Discord-permissies + intents heeft**
   In het Developer Portal, tabblad "Bot": zet **Server Members Intent** aan
   (nodig voor het welkomstbericht). Nodig bij het uitnodigen: `Manage Roles`,
   `Manage Channels`, `Send Messages`, `Embed Links`.

4. **Start alles in één proces** (handig voor hosting op één service, bv. Render):
   ```bash
   node start.js
   ```
   Dit registreert automatisch alle slash commands én start de API + bot samen.

   Los draaien kan ook:
   ```bash
   npm run api      # start alleen de Express API
   npm start        # start alleen de Discord bot
   npm run deploy   # registreer slash commands handmatig
   ```

5. **Open het dashboard** op `<PUBLIC_URL>/dashboard`, log in met Discord, kies
   je server, en stel tickets/welkomstbericht/verificatie/regels in.

## Hosten op Render

- Root Directory: de map met dit `package.json` (bv. `bot`, als dit een submap is).
- Build Command: `npm install`
- Start Command: `node start.js`
- Zet alle variabelen uit `.env.example` in Render → Environment.
- Gebruik Turso voor de database, anders is je SQLite-bestand weg na elke redeploy
  (Render's filesystem is niet persistent zonder een betaalde Disk).

## Commands overzicht

| Command | Wie | Doet |
|---|---|---|
| `/ticket-setup` | Management | Configureert en verstuurt het ticketpaneel |
| `/ticket-addtype` `/ticket-edittype` `/ticket-removetype` `/ticket-listtypes` | Management | Beheert ticket-types |
| `/ticket-claim` `/ticket-close` `/ticket-add` `/ticket-remove` `/ticket-list` | Staff | Dagelijks tickets beheren |
| `/welcome-test` | Management | Stuurt een testbericht met de huidige welkomst-config |
| `/verify-panel` | Management | Verstuurt het verificatie-paneel in een kanaal |
| `/checkverify` | Staff | Toont wie geverifieerd is |
| `/unverify` | Management | Verwijdert de verificatie-rol van een lid |
| `/rules-send` | Management | Plaatst/werkt de regels-embed bij |
| `/product add` | Management | Voegt een webshop-product toe (prijs 0 = gratis, bestand verplicht) |
| `/product update` | Management | Werkt naam/prijs/bestand/changelog bij, optioneel meteen een update-DM |
| `/product delete` | Management | Verwijdert een product uit de webshop |
| `/product list` | Management | Toont alle webshop-producten |
| `/product kanaal` | Management | Stelt het kanaal in met een automatisch bijgewerkt webshop-overzicht |
| `/announce` | Management | Stuurt een aankondiging |
| `/ban` `/kick` `/unban` | Management | Basis moderatie |
| `/userinfo` | Iedereen | Info over een lid |
| `/8ball` `/coinflip` `/roll` | Iedereen | Fun commands |
| `/shutdown` | Management | Sluit de bot netjes af |

Rollen (`STAFF_ROLE_ID`, `MANAGEMENT_ROLE_ID`) stel je in via `.env`. Server-admins
(Discord "Administrator" permissie) hebben altijd overal toegang toe.

## Giveaways

Knop-gebaseerde giveaways (🎉 "Meedoen"-knop met live deelnemersteller), overgenomen van het Forever-systeem.

Commands (alleen Management/Administrator):

- `/giveaway start [kanaal] [vereiste_rol]` — opent een formulier (duur, aantal winnaars, prijs, omschrijving)
- `/giveaway end` — beëindig een lopende giveaway meteen en trek winnaars
- `/giveaway reroll [aantal]` — trek nieuwe winnaar(s) voor een afgelopen giveaway
- `/giveaway list` — toon lopende giveaways

Winnaars worden automatisch getrokken zodra de timer afloopt (de bot controleert elke 20 seconden). Het dashboard heeft een tab "Giveaways" met een overzicht.
