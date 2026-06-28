# Void Dominion — Android APK (Capacitor)

Packages the **prototype** (`prototype/dist/void-dominion.html`, a self-contained
offline HTML game) into an installable Android APK by wrapping it in a Capacitor
WebView. No hosting needed — the HTML ships inside the app. The app is **branded**
(diamond crest icon + splash) and **locked to portrait** — the map defaults to a
zoomed-in view of your home region and you pan to explore. Standalone project (not in
the pnpm workspace); uses `npm`.

This is `cross-platform-roadmap.md` CP6.2 (Capacitor route — pulled forward ahead of
the CP6.1 TWA route to enable the multiplayer-via-APK test). The wrapped prototype
now ships **net mode**: its connect overlay can join a live session served by
`pnpm dev:proto-server`. See `docs/multiplayer.md` → "Two phones, one session" for
the friend-test runbook (server + `wss://` tunnel → sideload → both connect).

## Install on a phone (easiest)

Every push to `main` that touches the game refreshes a rolling **`alpha`** prerelease
with the latest build, at a stable link:

- **Releases page:** https://github.com/Moonwuk/Nygame/releases/tag/alpha
- **Direct APK:** https://github.com/Moonwuk/Nygame/releases/download/alpha/void-dominion-alpha.apk

On the phone: open the direct link → download → open the APK → allow "install from
unknown sources" if prompted → launch. **Single-player runs fully offline** (portrait).

It is a **debug** APK, signed with a **committed debug keystore** (`mobile/debug.keystore`,
standard `android`/`android` credentials — not a secret) so every build shares one
signature and updates install over the previous build. A Play-Store release/AAB still
needs a real (secret) keystore — a later step.

### If the install fails

- **"App not installed — it conflicts with another package"** — you have an older build
  installed that was signed with a *different* key (older builds regenerated the debug
  key each time). **Uninstall Void Dominion once**, then install this build; from now on
  the signature is stable, so future updates install straight over the top.
- **Google Play Protect "blocked for your protection"** — expected for a sideloaded
  debug APK from an unverified developer. Tap **Подробнее → Установить всё равно**
  (More details → Install anyway). It's the same code you build here.

## Get the APK as a CI artifact (any branch build)

Each run also uploads the APK as an artifact (handy for `claude/*` branch builds that
don't publish a release):

1. Actions tab → "Android APK (prototype)" → open the run (or **Run workflow**).
2. Download the **`void-dominion-debug-apk`** artifact.
3. Sideload `app-debug.apk` (enable "install from unknown sources").

## Build locally (needs JDK 17 + Android SDK)

```bash
cd mobile
npm install
npm run www          # builds the prototype and stages www/index.html
npx cap add android  # generates the native android/ project (first time only)
npm run apk          # sync → brand (icon/splash + landscape) → ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run apk` runs `npm run brand` between sync and the Gradle build:
`capacitor-assets generate --android` (icons + splash from `assets/`) then
`node patch-android.mjs` (forces `sensorLandscape` on the WebView activity).

Requirements: JDK 17, Android SDK (set `ANDROID_HOME`), and accepted SDK licenses.
`gradlew` downloads its own Gradle. Capacitor 6 ⇒ JDK 17.

## Notes

- `www/` and `android/` are generated (gitignored); only the config + scripts +
  `assets/` source art are tracked.
- Brand art lives in `assets/` (`icon-only` / `icon-foreground` / `icon-background`
  at 1024², `splash` / `splash-dark` at 2732²); regenerate with the scratch
  generator if the crest changes. `@capacitor/assets` fans them out to every density.
- App id `com.voiddominion.prototype`, name "Void Dominion".
- CI action versions are tag-pinned for now; SHA-pin them with the pipeline-hardening
  brick (SD-6.1) alongside the other workflows.
