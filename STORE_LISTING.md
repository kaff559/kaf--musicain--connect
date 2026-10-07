# Store listing copy — Kaf Musician Connect

Copy-paste starting points for the Google Play Console and App Store Connect
listing forms. Character limits are noted next to each field — trim if your
final app name or wording pushes it over. Edit freely; this is a draft, not
final marketing copy.

## App name

**Kaf Musician Connect**

## Google Play

**Short description** (max 80 characters)(78 characters)

**Full description** (max 4000 characters)
**App category:** Events, or Music & Audio (pick whichever your Play
Console offers that fits closest — both are reasonable)

**Tags/keywords to consider:** musician booking, DJ booking, live music,
event musician, equipment rental, MC booking, wedding musician, church
musician

## Apple App Store

**Subtitle** (max 30 characters — shows under the app name)(27 characters)

**Promotional text** (max 170 characters — can be updated anytime without
a new app version)
**Description** (max 4000 characters — same content as the Google Play
full description above works fine here too; Apple doesn't require
different wording)

**Keywords** (max 100 characters, comma-separated, no spaces after commas
— Apple strips duplicates of words already in your app name/subtitle)
**Category:** Primary: Music. Secondary (optional): Business or Lifestyle.

## Notes

- Payments run through PayPal (including Apple Pay and guest debit/credit
  card) but stay in demo mode — no money moves — until
  `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` are set on the deployed backend
  (see `DEPLOY.md`). Don't claim real payment processing in either store
  listing until those are set and you've tested a real booking/rental end
  to end.
- Both stores will ask for your privacy policy URL — that's
  `https://YOUR-LIVE-DOMAIN/privacy-policy.html` once deployed.
- Screenshots: both stores require at least 2 (Play) or a device-specific
  set (Apple, per required screen sizes). Good candidates from this app:
  the home search page, a musician's profile, a booking request/dashboard
  view, and the equipment rental browse page.