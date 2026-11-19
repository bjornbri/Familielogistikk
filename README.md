# Familielogistikk – testversjon

Felles familiekalender. Åpner på «I dag» med det som skjer nå og resten av dagen.
Har uke- og månedsvisning, en fullskjermtavle for nettbrett/vegg, og avtaler kan lages fra innlimte SMS-er og skjermbilder.

## Hva som er med

- Konto med e-post og passord (bcrypt). Innloggingen varer i 60 dager.
- Én familie per konto. Den som registrerer seg først, oppretter familien.
- **Inviter familiemedlemmer:** «Familie» → «Lag invitasjonslenke». Lenken virker én gang og gjelder i 7 dager.
- Alle i familien ser og redigerer de samme avtalene. Endringer hentes hvert 30. sekund.
- SMS-tolkning skjer i nettleseren.
- **Skjermbilder** leses gratis med tekstgjenkjenning (Tesseract, norsk) i nettleseren og tolkes av samme tolker som SMS. Bare hvis dato eller tid mangler, og `ANTHROPIC_API_KEY` er satt, spørres AI. Knappen «Les med AI i stedet» gjør det manuelt.
- **Kalenderabonnement:** lim inn en iCal-lenke (Spond via Google- eller iCloud-kalender, skolen, Google Kalender). Serveren henter avtalene hver halvtime, 14 dager bakover og 120 dager fremover, inkludert gjentakelser.
- **Stedssøk:** skriv «holmen svømme» i Sted-feltet og velg fra forslagene. Avtalen får adresse og lenke til Google Maps. Krever `GOOGLE_MAPS_API_KEY` (valgfritt). Uten nøkkel får alle steder likevel en «Åpne i Google Maps»-lenke basert på teksten.
- Kan legges til på Hjem-skjermen på iPhone/Android og åpnes som en app (web-manifest).

## Fjerne for én dag (sykdom, avlyst)

Sveip en avtale eller henting til venstre på **I dag** eller **tavla**, og trykk **«Fjern – bare i dag»**.
Bare den ene dagen skjules. Faste avtaler, ukentlige treninger og hentetider fremover er uendret.
Angre fra meldingen nederst, eller via **«Fjernet for dagen · vis» → Gjenopprett**. Inne i en avtale finnes også **«Fjern bare i dag»**.

## Henting

Foreldre legger inn faste tider under **Familie → Faste hentetider**: når skolen slutter, SFO eller barnehagen stenger, per barn og ukedag.
Tidene vises på I dag, tavla («Hvem henter i dag») og i ukevisningen. Det eneste som kan trykkes på, er **«Jeg henter»**. Da ser alle hvem som henter hvem.
En hentetid som ingen har bekreftet, markeres gult, og rødt fra 1,5 time før.

## Hjelp fra besteforeldre (uten konto)

- Legg inn **hjelpere** med navn og mobil under **Familie** (eller direkte første gang du spør).
- Ved en hentetid eller avtale: **«Spør om hjelp»** → velg hvem → **Send SMS**. Meldinger åpnes med ferdig tekst og en personlig lenke.
- Kryss av flere hentinger eller avtaler samme dag for å spørre om alt i **én SMS** («hente Leah på SFO kl. 15:00 og Oskar i barnehagen kl. 16:45 i dag»).
- Lenken (`/h/…`) åpner en enkel side med **«Ja, jeg kan»** / **«Nei, dessverre»**. Ingen innlogging.
- Spør du flere, får den som svarer ja først oppdraget. Appen viser «✓ Bestemor henter» og gir beskjed når noen svarer.
- Lenken viser bare den ene forespørselen og slutter å virke 2 timer etter hentetiden, eller når forespørselen avbrytes.
- Når hjelperen har sagt ja, viser lenken **barnets dag videre** ut dagen: avtaler etter hentingen med tid, sted, kartlenke og notat, hvem som tar dem, og barnets beskjeder. Bare det barnet, ingen andre i familien.

## Ukesoppgaver

- **Faste oppgaver** per barn og **oppgavebørs** med «først til mølla» (maks 2 reservert samtidig, 24 timers frist, kan endres).
- Barnet krysser av med **bilde**. En forelder **godkjenner** eller avviser. Bilder slettes automatisk etter 30 dager.
- **Ukelønn** per barn: hele beløpet når alle faste er godkjent, eller en andel per oppgave. Pluss betaling per oppgave.
- **Ukeoppgjør:** foreldre markerer beløpet som utbetalt. Appen flytter ikke penger.
- **Barnekontoer:** «Familie → Inviter barn». Barn kan ikke endre oppgaver, lønn eller familien.
- Tavla viser fremdrift per barn og ledige oppgaver i børsen.

## Kjør på Render

1. I Render: **New + → Blueprint**, velg dette repoet. `render.yaml` lager en webtjeneste og en Postgres-database i Frankfurt.
2. Valgfritt: legg inn `ANTHROPIC_API_KEY` når Render spør, for å slå på bildelesing.
3. Åpne adressen Render gir deg, og opprett den første kontoen.

Merk om gratisplanene hos Render:
- Webtjenesten sover etter en stund uten trafikk. Første besøk etter det kan ta opptil et minutt.
- Gratis Postgres er tidsbegrenset. Bytt til en betalt databaseplan før dere legger inn data dere vil beholde.

## Fjerne personer og kontoer

Under **Familie**:
- **Fjern** ved en person fjerner personen fra kalenderen (to trykk). Hentetider for personen slettes også.
- **Fjern** ved en konto i «Kontoer i familien» tar kontoen ut av familien. Bare foreldre kan gjøre dette, og ikke for den som opprettet familien.
- **Slett min konto** krever passord. Er du alene i familien, slettes hele familien med alt innhold. Den som opprettet familien, gir den videre til en annen forelder.

## Bruksstatistikk

Åpne `/admin` (eller **Familie → Bruksstatistikk**) når e-posten din står i `ADMIN_EMAILS`.
Siden viser hvor stor andel av de aktive familiene som bruker appen 4 dager eller mer i uka, aktive per dag, hvilke funksjoner som brukes, og en anonym liste over familiene. Den lagrer bare hvilke dager en konto åpnet appen, aldri innhold.

## «Glemt passord»

Brukeren får en lenke på e-post som virker i 1 time og én gang. Nytt passord logger ut alle andre enheter.
Krever en konto hos [Resend](https://resend.com) (gratisnivå holder) med domenet verifisert, og `RESEND_API_KEY` og `MAIL_FROM` i Render.
Uten nøkkel skrives lenken bare i serverloggen.

## Google Maps-nøkkel (stedssøk)

1. Gå til console.cloud.google.com, lag et prosjekt og legg inn betalingskonto.
2. Slå på **Places API (New)** under «APIs & Services → Library».
3. Lag en nøkkel under «Credentials → Create credentials → API key».
4. Begrens nøkkelen: «API restrictions» → bare *Places API (New)*. Sett gjerne en kvote eller et budsjettvarsel.
5. Legg den inn i Render som `GOOGLE_MAPS_API_KEY` (Environment på webtjenesten).

Nøkkelen brukes bare fra serveren og vises aldri i nettleseren.

## Kjør lokalt

```bash
npm install
cp .env.example .env   # fyll inn DATABASE_URL
export $(grep -v '^#' .env | xargs) && npm run dev
```

Tabellene opprettes automatisk ved oppstart.

## Struktur

- `server.js` – API, innlogging, invitasjoner, bildelesing
- `public/index.html` – hele appen (én side)
- `render.yaml` – oppsett for Render

## Neste steg

- Face ID / Touch ID med passkeys (WebAuthn) – fungerer i nettleser og senere i native app
- Push-varsler: morgenbrief kl 07 og påminnelser (Web Push for Hjem-skjerm-app, APNs/FCM i native app)
- «Glemt passord» via e-post
- Native app (f.eks. Capacitor eller React Native) for App Store med abonnement via In-App Purchase
