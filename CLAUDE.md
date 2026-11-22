# Familielogistikk – for utviklere og AI-assistenter

Les denne først. Den beskriver hvordan appen er bygget, hvordan den kjøres og
hvilke regler som gjelder. Eier: Bjørn (produkt, kontoer, drift). All tekst i
appen er på norsk bokmål.

## Hva appen er

Felles familiekalender: «I dag»-oversikt, uke/måned, avtaler fra SMS/skjermbilde
(tekst eller bilde → Claude-API), faste hentetider, ukesoppgaver for barn med
utbetaling, beskjeder, «tar den»-bekreftelser, Spond/iCal-abonnement, tavle for
veggskjerm, og hjelp fra besteforeldre uten konto (lenke på SMS → svarside).
Målet er App Store/Google Play i Norge, Sverige og Danmark.

## Arkitektur

- **`server.js`** – hele backend: Express 4 + Postgres (`pg`). Ingen ORM, ingen
  build-steg. Tabellene opprettes/endres i `migrate()` ved oppstart med
  `create table if not exists` / `alter table … add column if not exists`.
  Nye kolonner legges alltid til slik, aldri med destruktive migrasjoner.
- **`public/index.html`** – hele appen som én side (vanilla JS i én IIFE).
  Tilstand i `S`, alt tegnes av `render()`. `$` = `document.querySelector`.
  `api(path, {method, body})` legger på `X-FL: 1` og håndterer 401.
- **`public/help.html`** – offentlig svarside for hjelpere (`/h/:token`).
- **`public/admin.html`** – bruksstatistikk og driftsmelding (`/admin`, kun `ADMIN_EMAILS`).
- **`render.yaml`** – Render Blueprint: `familielogistikk` (branch `main`),
  `familielogistikk-test` (branch `staging`, `DB_SCHEMA=staging`) og databasen.

## Sikkerhetsregler (ikke bryt disse)

- Alle ikke-GET-kall til `/api` krever headeren `X-FL: 1` (CSRF-vern).
- Innlogging med httpOnly-cookie `fl_sess`; passord med bcryptjs.
- `parentOnly` på alt barnekontoer ikke skal kunne endre. Barnekontoer har `users.kind = 'child'`.
- Alt fra brukere går gjennom `clean(value, maxLen)`; frontend escaper med `esc()`.
- Alle spørringer filtrerer på `family_id` fra innlogget bruker – aldri fra klienten.
- API-nøkler ligger kun i Render → Environment. Aldri i kode, commits eller chat.
- Persondata (e-post, navn, avtaleinnhold) sendes ikke til tredjepart, med unntak
  av bilde-/tekstlesing (Anthropic) og stedssøk (Google) når brukeren selv ber om det.
  Sentry er satt opp med `sendDefaultPii: false`.
- `parentOnly` er en `function`-deklarasjon fordi den brukes før definisjonen.

## Miljøvariabler

| Variabel | Påkrevd | Hva |
|---|---|---|
| `DATABASE_URL` | ja | Postgres |
| `PGSSL` | nei | `false` lokalt uten SSL |
| `APP_ENV` | nei | `produksjon` / `test` – testmiljøet får en «Testmiljø»-stripe |
| `DB_SCHEMA` | nei | Egne tabeller i samme database (testmiljøet bruker `staging`) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | nei | Les avtale fra bilde/tekst |
| `GOOGLE_MAPS_API_KEY` | nei | Stedssøk |
| `ADMIN_EMAILS` | nei | Kommaseparert, gir tilgang til `/admin` |
| `RESEND_API_KEY`, `MAIL_FROM` | nei | E-post (glemt passord). Uten nøkkel logges lenken |
| `SENTRY_DSN` | nei | Feillogging til Sentry (server + nettleser via `/api/client-error`) |
| `PUBLIC_URL` | nei | Ellers brukes `RENDER_EXTERNAL_URL` |
| `ALLOW_PRIVATE_FEEDS` | nei | Kun for lokal test av kalenderabonnement |

`RENDER_GIT_COMMIT` settes av Render og vises som versjon i `/healthz` og `/admin`.

## Drift og overvåking

- **`GET /healthz`** → `{"ok":true,"db":true,"version":"abc1234","env":"produksjon"}`.
  Svarer 503 hvis databasen ikke svarer innen 3 sekunder. Brukes av Render og
  oppetidsovervåking (UptimeRobot e.l.).
- **`GET /api/status`** – offentlig driftsmelding. Settes i `/admin`
  (`PUT /api/admin/status`, nivå `info`/`down`) og vises som stripe øverst i appen.
- **`POST /api/client-error`** – nettleserfeil (maks 5 per økt, 20 per 10 min per IP)
  logges med `[klientfeil]` i serverloggen og sendes til Sentry hvis den er på.
- Opprydding kjører hver time (gamle økter, tilbakestillinger, aktivitet, osv.).
- Driftshåndboken for Bjørn ligger som dokument i Claude (lenke i lanseringsplanen).

## Arbeidsflyt

1. Jobb på `main` lokalt, test, og push til **`staging`** først:
   `git push origin main:staging` → testmiljøet bygger på nytt.
2. Sjekk testmiljøet (logg inn, prøv det som er endret).
3. Push til `main` → produksjon bygger på nytt automatisk.
4. Går noe galt i produksjon: Render → familielogistikk → Events → «Rollback» til forrige deploy.

Commit-meldinger skrives på norsk og beskriver hva brukeren merker.

## Kjør og test lokalt

```bash
# Postgres (i Claude-miljøet): pg_ctlcluster 16 main start
npm install
export DATABASE_URL=postgres://fl:fl@localhost:5432/fl PGSSL=false ADMIN_EMAILS=admin@test.no
npm run dev                         # http://localhost:3000
DB_SCHEMA=staging APP_ENV=test PORT=3002 node server.js   # som testmiljøet
```

Testing gjøres ende-til-ende med Playwright (forhåndsinstallert i Claude-miljøet:
`NODE_PATH=$(npm root -g) node test.js`). Registrer en bruker via `POST /api/register`
med `X-FL: 1`, og test i 400 px bredde (mobil). Pass på at Playwrights falske klokke
ikke blandes med serverens ekte tid.

## Kjente fallgruver

- pg: «could not determine data type of parameter» → gi parameteren en cast (`$4::date`).
- Datoer fra Postgres kan forskyves av tidssone – bruk `to_char(...)` i SQL når dato skal vises.
- CSS-klassen `.bar` er opptatt; fremdriftslinjen heter `.prog`.
- Render free: webtjenesten sovner etter 15 min uten trafikk (første kall tar ~1 min),
  og gratis Postgres utløper etter 30 dager og har ingen sikkerhetskopi.
  Oppgrader databasen før ekte brukere.
