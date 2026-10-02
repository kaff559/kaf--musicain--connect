# Kaf Musician Connect — mobile app wrapper

This folder turns the live site (kafmusicianconnect.com) into real iOS and
Android apps using Capacitor. It does **not** touch the main app in
`../public` or `../server` — this is purely a native shell that loads the
live site in a full-screen WebView, the same pattern Capacitor is built for.
Because `capacitor.config.json` points at the live URL (not local files),
the app always shows whatever's currently deployed — no app update needed
for ordinary site changes, only for icon/permission/native-plugin changes.

Run everything below from inside this `mobile` folder.

## One-time setup (do this on your Windows PC first — it has working
## internet and can generate both platforms' project folders)

```bash
npm install
npx cap add android
npx cap add ios
npx @capacitor/assets generate --iconBackgroundColor "#0a1128" --splashBackgroundColor "#0a1128"
```

`cap add ios` and `cap add android` just copy template native projects —
they don't need Xcode or Android Studio to run, only to actually *build*
afterward. So it's fine to generate both here on Windows.

`@capacitor/assets generate` reads `resources/icon.png` (1024×1024) and
`resources/splash.png`/`splash-dark.png` (2732×2732) — already included in
this folder, upscaled from your existing app icon — and writes every
required iOS/Android icon and splash-screen size automatically into the
`ios/` and `android/` folders it just created.

Then commit everything so your Mac can just `git pull` instead of
regenerating anything:

```bash
git add mobile
git commit -m "Add Capacitor mobile app wrapper (iOS + Android)"
git push
```

## Building for iOS (on your Mac)

```bash
git pull
cd mobile
npx cap open ios
```

That opens Xcode. In Xcode:
1. Click the top-level "App" project → Signing & Capabilities → pick your
   paid Apple Developer team.
2. Pick a real device or "Any iOS Device" as the build target (not a
   Simulator) once you're ready to archive.
3. Product → Archive.
4. Once archived, the Organizer window opens → Distribute App → App Store
   Connect → follow the prompts. This is also where you'll later submit to
   TestFlight for testing before a full public release.

You'll still need to create the app's listing in App Store Connect
(screenshots, description, age rating, privacy info) — Apple requires that
regardless of how the app was built.

## Building for Android (on your Windows PC)

```bash
npx cap open android
```

That opens Android Studio. From there:
1. Build → Generate Signed Bundle / APK → Android App Bundle (AAB) — Google
   Play requires AAB, not APK, for new apps now.
2. Create a new signing key the first time (keep the `.jks` file and its
   password somewhere safe — you cannot update the app later without it).
3. Upload the resulting `.aab` to the Google Play Console.

You'll need a Google Play Developer account first (one-time $25 fee at
play.google.com/console/signup) if you haven't registered one yet — this is
separate from the Apple account you already have.

## A note on App Store review

Apple's guidelines (4.2, "Minimum Functionality") sometimes flag apps that
are *only* a website wrapped in a WebView with no real app behavior. Kaf
Musician Connect has substantial logged-in functionality (accounts,
bookings, payments, profiles, notifications) beyond passive browsing, which
is the kind of thing that generally clears review — but it's still worth
knowing this guideline exists in case Apple asks follow-up questions during
review.

## Updating the icon/splash later

Replace `resources/icon.png` (1024×1024) and `resources/splash.png` /
`splash-dark.png` (2732×2732, same image works for both since the app theme
is already dark) with better originals whenever you have them, then rerun:

```bash
npx @capacitor/assets generate --iconBackgroundColor "#0a1128" --splashBackgroundColor "#0a1128"
```
