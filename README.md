# AUREX DEVELOPMENT — Development Shop Bot + Dashboard

**Deserve All Right.**

## Architectuur

E�n service (`bot/`) draait **zowel de Discord-bot als de dashboard-website**
in hetzelfde proces, via `server.js`:

- `server.js` start een Next.js-server (voor `/`, `/dashboard/*`, `/api/*`)
  én logt tegelijk de Discord-bot in — allebei op dezelfde poort/dezelfde URL.
- Klik je op de knop van `/dashboard` in Discord, dan land je op
  `https://<jouw-app>.onrender.com/dashboard/<guildId>` — dus letterlijk
  dezelfde plek als waar de bot draait, met `/dashboard` erachter.

Structuur:

```
bot/
  server.js              ← entrypoint: start web + bot samen
  src/                    ← alle Discord-botcode (commands, events, handlers)
    bot.js                ← startBot(): client aanmaken, inloggen
    index.js               ← losstaande bot-only entrypoint (lokaal testen)
  app/                    ← Next.js dashboard (App Router)
    dashboard/              ← /dashboard?guild=<id>, /dashboard/products?guild=<id>, ...
    api/
      auth/[...nextauth]/   ← enige map met haken in het hele project (verplicht door NextAuth)
      products/, orders/, settings/   ← vlakke API-routes, guildId gaat via query/body
  components/             ← React-componenten voor het dashboard
  lib/                    ← auth.js, permissions.js, pageGuard.js, discord.js, prisma.js
  prisma/schema.prisma    ← gedeeld datamodel voor bot én dashboard
```

Let op: het dashboard gebruikt `/dashboard?guild=<id>` (een **query-parameter**), niet
`/dashboard/<id>/...` — dat is bewust zo gekozen zodat bijna geen enkele map in dit
project vierkante haken (`[...]`) in de naam heeft. Dat maakt uploaden via GitHub's
webinterface (drag-and-drop) een stuk minder foutgevoelig, omdat alleen de
NextAuth-inlogmap (`app/api/auth/[...nextauth]/`) die naamgeving nog vereist.

## Rechten in het dashboard

Bij elk bezoek aan `/dashboard/<guildId>` haalt de server via de **bot-token**
de rollen van de ingelogde gebruiker op in die Discord-server, matcht die
tegen `StaffPermission` in de database, en toont alleen de secties waar die
rol rechten voor heeft. De Discord-server-eigenaar heeft altijd volledige
toegang. Geen staff-rol = geen toegang, met duidelijke melding. Elke
API-route herhaalt deze check server-side (nooit alleen op de UI vertrouwen).

## Database: Turso (libSQL)

Dit project gebruikt **Turso** in plaats van Postgres. Omdat Turso op SQLite
is gebaseerd, ondersteunt het geen native arrays, JSON-kolommen of enums —
die velden zijn daarom in het schema gewone `String`-kolommen die JSON-tekst
bevatten (bv. `features` op een product), met kleine helpers in `lib/json.js`
(`parseJson` / `toJsonString`) om dat om te zetten in de code. "Enums" (zoals
orderstatussen) zijn nu gewoon strings — dezelfde waarden als voorheen (bv.
`"PENDING"`, `"PAID"`), alleen zonder database-afdwinging.

### Turso-database aanmaken

```bash
# eenmalig, als je de Turso CLI nog niet hebt:
curl -sSfL https://get.tur.so/install.sh | bash

turso auth login
turso db create aurex-db
turso db show aurex-db --url          # → TURSO_DATABASE_URL
turso db tokens create aurex-db       # → TURSO_AUTH_TOKEN
```

Zet beide waarden in je `.env` (lokaal) en in de Environment Variables van je
Render-service (productie).

### Migraties toepassen

Prisma's migratie-commando kan niet rechtstreeks tegen een externe Turso-
database draaien, dus het gaat in twee stappen: eerst lokaal de migratie-SQL
laten genereren (tegen een tijdelijk lokaal bestand), en die SQL dan naar
Turso sturen.

```bash
cd bot
npm install

# 1. Genereer de migratie lokaal (DATABASE_URL wijst hiervoor naar een lokaal bestand)
npm run migrate:local -- --name init

# 2. Stuur diezelfde migratie-SQL naar je echte Turso-database
npm run migrate:turso
```

Voor elke latere schema-wijziging herhaal je dit: eerst `migrate:local` om
nieuwe migratie-SQL te genereren, dan `migrate:turso` om 'm toe te passen.

## Lokaal draaien

```bash
cd aurex-development/bot
cp ../.env.example .env      # vul token, client id/secret, Turso-gegevens in
npm install
npm run migrate:local -- --name init
npm run migrate:turso
npm run deploy-commands      # registreert de slash commands bij Discord
npm run dev                  # start bot + dashboard samen op :3000
```

Zet in het Discord Developer Portal onder OAuth2 → Redirects:
`http://localhost:3000/api/auth/callback/discord`.

## Deployen op Render

`render.yaml` is verwijderd — je stelt de service handmatig in via de Render-
interface (New → Web Service):

1. Push naar GitHub/GitLab, koppel de repo in Render.
2. **Root Directory**: `bot`
3. **Build Command**: `npm install && npx prisma generate && npm run build`
4. **Start Command**: `npm start`
5. Environment Variables: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`,
   `DISCORD_CLIENT_SECRET`, `NEXTAUTH_SECRET`, `TURSO_DATABASE_URL`,
   `TURSO_AUTH_TOKEN`. (`DATABASE_URL` hoef je in productie niet te zetten —
   die wordt alleen lokaal gebruikt om migraties te genereren.)
6. Migraties zijn al toegepast op Turso via `npm run migrate:turso` (zie
   hierboven) — dat hoeft Render niet opnieuw te doen.
7. Render geeft je één URL, bv. `https://aurex-development.onrender.com`.
   Voeg in het Discord Developer Portal onder OAuth2 → Redirects toe:
   `https://aurex-development.onrender.com/api/auth/callback/discord`.
   `NEXTAUTH_URL` hoef je niet zelf te zetten — Render injecteert
   `RENDER_EXTERNAL_URL` automatisch en de code gebruikt die als fallback.
8. Eenmalig ná de eerste succesvolle deploy: registreer de slash commands.
   Draai `npm run deploy-commands` lokaal met dezelfde
   `DISCORD_TOKEN`/`DISCORD_CLIENT_ID` als productie (of tijdelijk als losse
   Render **Job**).

Bot aanmaken: Discord Developer Portal → New Application → Bot → token en
client id/secret naar je envvars. Nodig de bot uit met `applications.commands`
en `bot`-scopes en minimaal: Manage Channels, Manage Roles, Send Messages,
Embed Links, Read Message History.

## Roadmap — resterende modules

Elke module volgt hetzelfde patroon (command/pagina → database → Discord-actie
of dashboard-render) en kan los gebouwd worden:

1. **Welcome/goodbye-systeem** — `guildMemberAdd`-event + templating (`{user}`,
   `{username}`, `{server}`) + live preview via dashboard
2. **Verificatiesysteem** — apart van klantstatus; verified-rol ≠ verified customer
3. **Klantensysteem verdiepen** — `/customer`, `/customer-history`, notities,
   automatische rol-toekenning ná betaalcontrole
4. **Productcatalogus afmaken** — `/shop` en `/products` tonen gepubliceerde
   producten als embeds met bestelknop, publiceren/verbergen vanuit dashboard
5. **Order management** — `/order create|status|assign|complete|cancel`,
   statusupdates naar klant, koppeling met tickets
6. **Transcripts** — `discord-html-transcripts`-package, opslaan + linken in
   `logTickets`
7. **Embed builder** — modal-gebaseerde editor in Discord óf builder in het
   dashboard, met Save/Preview/Send Test/Publish
8. **Dashboard uitbreiden** — Tickets, Customers, Reviews, Embeds,
   Moderation, Staff-rechtenmatrix, Logs, Bot Status, Website Settings —
   volgen exact het patroon van Products/Orders
9. **Logging & foutafhandeling** — centrale logger die naar de juiste
   `log*`-kanalen post + foutregistratie voor bot-fouten

## Belangrijk

Geen enkele koppeling (betalingen, licenties, verificatie) is nagemaakt of
gesimuleerd — alles schrijft naar echte database-records, en features die een
externe koppeling nodig hebben (bv. een betaalprovider) tonen duidelijk "niet
verbonden" totdat jij die koppeling toevoegt.
