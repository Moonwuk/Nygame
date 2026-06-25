# Void Dominion — Android APK (Capacitor)

Packages the **prototype** (`prototype/dist/void-dominion.html`, a self-contained
offline HTML game) into an installable Android APK by wrapping it in a Capacitor
WebView. No hosting needed — the HTML ships inside the app. Standalone project
(not in the pnpm workspace); uses `npm`.

This is `cross-platform-roadmap.md` CP6.2 (Capacitor route — pulled forward ahead of
the CP6.1 TWA route to enable the multiplayer-via-APK test). The wrapped prototype
now ships **net mode**: its connect overlay can join a live session served by
`pnpm dev:proto-server`. See `docs/multiplayer.md` → "Two phones, one session" for
the friend-test runbook (server + `wss://` tunnel → sideload → both connect).

## Get the APK without a local Android toolchain (recommended)

The GitHub Actions workflow **`Android APK (prototype)`** builds it on a runner that
already has the Android SDK:

1. Actions tab → "Android APK (prototype)" → **Run workflow** (it also runs on pushes
   that touch `prototype/**` or `mobile/**`).
2. Download the **`void-dominion-debug-apk`** artifact from the finished run.
3. Sideload `app-debug.apk` (enable "install from unknown sources").

It is a **debug** APK (signed with Android's debug key) — fine for testing, not for
the Play Store. A release/AAB needs a signing keystore (a later step).

## Build locally (needs JDK 17 + Android SDK)

```bash
cd mobile
npm install
npm run www          # builds the prototype and stages www/index.html
npx cap add android  # generates the native android/ project (first time only)
npm run apk          # sync + ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Requirements: JDK 17, Android SDK (set `ANDROID_HOME`), and accepted SDK licenses.
`gradlew` downloads its own Gradle. Capacitor 6 ⇒ JDK 17.

## Notes

- `www/` and `android/` are generated (gitignored); only the config + scripts are tracked.
- App id `com.voiddominion.prototype`, name "Void Dominion".
- CI action versions are tag-pinned for now; SHA-pin them with the pipeline-hardening
  brick (SD-6.1) alongside the other workflows.
