# Getting Kaf Musician Connect into the App Store & Google Play

## The honest starting point

I'm working from a Linux sandbox with no access to the npm package registry
(that's the same block that shaped this whole project to run on zero npm
dependencies — see `README.md`). That means I can't install the Capacitor
CLI or Android/Xcode tooling here, so I can't run the actual build myself
in this session — everything below is written for you to run on your own
machines, and I can review any output or error messages you paste back.

You now have two machines to work with: the Windows PC connected to this
session (which can build the **Android** app end-to-end in Android Studio),
and your **Mac**, which is what you'll need for the **iOS** build — Xcode
only runs on macOS, that's an Apple rule, not a Claude limitation. This
session's remote-control bridge is only connected to your Windows PC right
now, so I can't run commands on the Mac directly from here — you'll run the
iOS steps yourself in a terminal on the Mac, and I can help debug anything
that comes up.

What I *have* done, so the rest is mostly following steps rather than
figuring things out:

- Prepared `capacitor.config.json` (the file that turns this web app into a
  native app shell).
- Generated all the app icon assets both stores require, in `store-assets/`.
- Written the exact commands for both platforms below.

Capacitor works by wrapping your **live, deployed website** in a native
shell — the phone app just opens your real site full-screen, with native
APIs available if you ever need them (push notifications, camera, etc.).
That means **the backend has to be deployed first** (Railway or Render —
see `DEPLOY.md`); the native app talks to that live server, same as a
browser would.

## Prerequisites checklist

| Requirement | Android (Google Play) | iOS (App Store) |
|---|---|---|
| Developer account | Google Play Developer — **$25 one-time** | Apple Developer Program — **$99/year** (you already have this ✅) |
| Build machine | Your Windows PC (Android Studio) | Your Mac (Xcode) ✅ |
| Time to first review | Usually hours | Usually 1–3 days |
| Privacy policy URL | Required | Required |

Because this app creates real accounts and stores real personal data
(names, emails, phone numbers, bookings), **both stores will require a
privacy policy URL** in the store listing. I've drafted one — it's the
page at `public/privacy-policy.html`, and it's linked in the app's footer
so it's already reachable from inside the app at `/privacy-policy.html`.
Once you deploy the backend (Step 1), that page will be live at your real
domain, e.g. `https://kaf-musician-connect.up.railway.app/privacy-policy.html`
— that's the URL to paste into both stores' listing forms. **Have a lawyer
review it before you submit** — it's a solid starting draft grounded in what
the app actually collects, not a substitute for legal review.

## Step 1 — Deploy the backend

Follow `DEPLOY.md` (Railway is the simpler option) and confirm the site
works at its real URL — e.g. `https://kaf-musician-connect.up.railway.app`.
Then open `capacitor.config.json` in this project and replace
`YOUR-DEPLOYED-DOMAIN-HERE` with that real URL.

## Step 2 — Install the tools (on your Windows PC, not in this sandbox)

Node's npm registry isn't blocked on your machine, so this should just work
in a normal terminal (PowerShell or Command Prompt) inside this project
folder:

```bash
npm install -g @capacitor/cli
npm install @capacitor/core @capacitor/android @capacitor/ios
npx cap init "Kaf Musician Connect" "com.kafmusicianconnect.app" --web-dir public
```

(The `capacitor.config.json` I already wrote will be picked up/merged —
if `cap init` overwrites it, just paste the `server` block back in from
the version in this project.)

## Step 3 — Android (buildable entirely on your Windows PC)

1. Install [Android Studio](https://developer.android.com/studio) (free).
2. In the project folder:
```bash
   npx cap add android
   npx cap copy android
   npx cap open android
```
   This opens the generated `android/` project in Android Studio.
3. Replace the default icons with the ones I generated:
   - `store-assets/android/adaptive-icon-foreground.png` and
     `adaptive-icon-background.png` → use Android Studio's
     **Image Asset** tool (right-click `res` → New → Image Asset) and
     point it at these two files to regenerate all the mipmap sizes
     correctly.
   - `store-assets/android/icon-512-store.png` → this is the 512×512
     icon you upload directly to the Play Console listing (not part of
     the app itself).
4. Build → Generate Signed Bundle/APK, choosing **Android App Bundle**
   (`.aab` — this is what Play Store wants now, not a raw `.apk`).
   Android Studio walks you through creating a signing key — **save that
   keystore file and its password somewhere safe**; you'll need the exact
   same one for every future update, and losing it means you can never
   update this app listing again.
5. Create a [Google Play Developer account](https://play.google.com/console/signup)
   ($25 one-time), create a new app, and upload the `.aab` under
   **Production → Create release**. You'll also fill in: store listing
   (title, description, screenshots — at least 2, phone-sized), content
   rating questionnaire, and the privacy policy URL.
6. Submit for review.

## Step 4 — iOS (on your Mac)

Since you have a Mac and an Apple Developer Program membership already, this
is the straightforward path — everything runs locally in Xcode, no cloud
build service needed. Do the following **on the Mac**, in a terminal, inside
this project folder (copy the project over first, e.g. via AirDrop, a USB
drive, or cloning the same git repo):

1. Install [Xcode](https://apps.apple.com/us/app/xcode/id497799835) from the
   Mac App Store if you don't have it yet (it's a large download — worth
   starting early). Also install [Node.js](https://nodejs.org) on the Mac if
   it isn't already there.
2. Install CocoaPods, which Capacitor's iOS build needs:
```bash
   sudo gem install cocoapods
```
3. Run Step 2 (installing the Capacitor CLI and `npx cap init`) on the Mac
   if you haven't already run it elsewhere — `node_modules` and the
   `ios`/`android` folders aren't committed to git, so each machine that
   builds needs its own `npm install`.
4. Add and copy the iOS platform:
```bash
   npx cap add ios
   npx cap copy ios
   npx cap open ios
```
   This opens `ios/App/App.xcworkspace` in Xcode.
5. Replace the app icon with `store-assets/ios/icon-1024.png` — drag it
   into the `AppIcon` entry in `Assets.xcassets`; Xcode 14+ generates every
   other size automatically from that one 1024×1024 image.
6. Set the Bundle Identifier to `com.kafmusicianconnect.app` and, under
   **Signing & Capabilities**, select your Apple Developer team — since
   you already have the paid membership, Xcode should pick it up
   automatically once you're signed into your Apple ID in Xcode's
   Settings → Accounts.
7. In [App Store Connect](https://appstoreconnect.apple.com), create a new
   app with that same bundle ID, fill in the listing (screenshots for at
   least one device size, description, privacy policy URL, age rating),
   and use Xcode's **Product → Archive → Distribute App** to upload the
   build.
8. Submit for review. Apple will also ask a few compliance questions
   (export compliance, whether the app uses encryption — standard HTTPS
   only counts as exempt, so that's a "yes, exempt" answer in most cases).

If for some reason you'd rather not build locally, cloud CI services like
[Codemagic](https://codemagic.io) or [Ionic Appflow](https://ionic.io/appflow)
can build and sign the iOS app from your project files without touching
Xcode directly — but with a Mac in hand, building locally is simpler and
free, so that's the path above.

## A couple of things reviewers may flag

- **Payments run through PayPal** (see `README.md`/`DEPLOY.md`) — real
  money only moves once `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` are set on
  the deployed backend; until then it's demo mode. Apple in particular has
  rules about when Apple's own in-app purchase system is required versus
  when external payment is fine — since this books real-world services
  (like Uber or a contractor-booking app), external payment through PayPal
  is normally allowed, but it's worth a quick read of Apple's guideline
  3.1.3 before submitting once you're taking real payments.
- **Account deletion** — both stores require a way for users to delete
  their account from inside the app, not just contact support. This is
  now built in: logged-in users can go to **Account** in the nav bar →
  **Delete my account** under "Danger zone," confirm with their password,
  and their profile/listings/favorites/notifications are removed and they're
  signed out everywhere. It's documented in the privacy policy too.

## What I can help with next

- Write the store listing description/screenshots copy.
- Re-check anything here once you've got Node/Capacitor running locally —
  I can review error messages, config files, etc. even though I can't run
  the build myself.