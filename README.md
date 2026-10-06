# MONTÉRO FALL GUYS CUP 2026 – PRO VERSION

## Enthalten
- Premium Montéro Turnier-Landingpage
- Live Plätze: `x / 32`
- Fortschrittsbalken
- offene/volle Anmeldung
- Website-Anmeldung
- Discord Button + Modal-Anmeldung
- gemeinsame Teilnehmerdatenbank
- optional automatische Discord-Teilnehmerrolle
- Admin-Teilnehmerliste
- Shopify Custom-Liquid Embed

## Start lokal
1. Node.js 24+ installieren
2. `npm install`
3. `.env.example` nach `.env` kopieren
4. Discord-Werte eintragen
5. `npm start`
6. http://localhost:3000

## Discord
Im gewünschten Channel:
`/turnier-panel`

Dann erscheint:
🏆 MONTÉRO FALL GUYS CUP 2026
[ 🎮 JETZT ANMELDEN ]

## Online stellen
Die App benötigt einen Node.js-Host (z.B. einen Dienst, der Node-Webapps aus einem Git-Repository startet).
Für die Produktion:
- `PUBLIC_BASE_URL` setzen
- `ADMIN_KEY` stark wählen
- CORS im server.js auf `https://monteroclothing.ch` bzw. deine Turnierdomain einschränken
- HTTPS verwenden
- SQLite nur bei persistentem Storage einsetzen; bei einem Host ohne persistenten Datenträger PostgreSQL/Supabase o.ä. verwenden.

## Eigene Subdomain
Empfohlen:
`cup.monteroclothing.ch`

Dann zeigt der Shopify-Button auf:
`https://cup.monteroclothing.ch`

## Shopify
Die Datei `shopify-custom-liquid.liquid` enthält einen einfachen iframe-Einbau.
In Shopify:
Online Store → Themes → Customize → gewünschte Seite → Custom Liquid
und den Code aus der Datei einfügen.

Noch besser für die endgültige Version:
Eine native Shopify-Sektion bauen, die direkt gegen die Turnier-API postet. Dann sieht die Anmeldung komplett wie ein Teil deines Shops aus.

## Vor öffentlichem Start
- Teilnahmebedingungen festlegen
- Mindestalter festlegen
- Datenschutz/Einwilligung prüfen
- Preisgeld und Sachpreise festlegen
- Ersatzspieler/No-Show-Regel festlegen
- Startzeit und Check-in-Zeit festlegen
- Discord-Server und Moderation vorbereiten
