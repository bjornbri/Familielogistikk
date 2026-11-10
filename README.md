# Familielogistikk – testversjon

Felles familiekalender. Åpner på «I dag» med det som skjer nå og resten av dagen.
Har uke- og månedsvisning, en fullskjermtavle for nettbrett/vegg, og avtaler kan lages fra innlimte SMS-er og skjermbilder.

## Hva som er med

- Konto med e-post og passord (bcrypt). Innloggingen varer i 60 dager.
- Én familie per konto. Den som registrerer seg først, oppretter familien.
- **Inviter familiemedlemmer:** «Familie» → «Lag invitasjonslenke». Lenken virker én gang og gjelder i 7 dager.
- Alle i familien ser og redigerer de samme avtalene. Endringer hentes hvert 30. sekund.
- SMS-tolkning skjer i nettleseren. Lesing fra **bilder** krever `ANTHROPIC_API_KEY` på serveren (valgfritt).
- **Stedssøk:** skriv «holmen svømme» i Sted-feltet og velg fra forslagene. Avtalen får adresse og lenke til Google Maps. Krever `GOOGLE_MAPS_API_KEY` (valgfritt). Uten nøkkel får alle steder likevel en «Åpne i Google Maps»-lenke basert på teksten.
- Kan legges til på Hjem-skjermen på iPhone/Android og åpnes som en app (web-manifest).

## Kjør på Render

1. I Render: **New + → Blueprint**, velg dette repoet. `render.yaml` lager en webtjeneste og en Postgres-database i Frankfurt.
2. Valgfritt: legg inn `ANTHROPIC_API_KEY` når Render spør, for å slå på bildelesing.
3. Åpne adressen Render gir deg, og opprett den første kontoen.

Merk om gratisplanene hos Render:
- Webtjenesten sover etter en stund uten trafikk. Første besøk etter det kan ta opptil et minutt.
- Gratis Postgres er tidsbegrenset. Bytt til en betalt databaseplan før dere legger inn data dere vil beholde.

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
