// Force the WebView activity to portrait after `cap add android`.
//
// The game is played vertically on a phone: the map defaults to a zoomed-in view of
// the home region and you pan to explore, while the build/fleet panels stack in the
// portrait column. Locking to portrait keeps that layout stable (no jarring relayout
// on rotation).
//
// The generated android/ project is gitignored and re-created on every build, so
// this runs each time and is idempotent. Capacitor's `cap sync` never rewrites the
// manifest, so a single post-add patch sticks through the rest of the build.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifest = fileURLToPath(
  new URL('./android/app/src/main/AndroidManifest.xml', import.meta.url),
);
let xml = readFileSync(manifest, 'utf8');

if (xml.includes('android:screenOrientation')) {
  console.log('AndroidManifest already pins screenOrientation — leaving it as-is.');
} else {
  const before = xml;
  // Inject the attribute right before the MainActivity name so it lands inside that
  // activity's opening tag (Capacitor's template lists android:name=".MainActivity").
  xml = xml.replace(
    /(\s*)android:name="\.MainActivity"/,
    '$1android:screenOrientation="portrait"$1android:name=".MainActivity"',
  );
  if (xml === before) {
    throw new Error('patch-android: could not find .MainActivity in AndroidManifest to lock orientation');
  }
  writeFileSync(manifest, xml);
  console.log('patch-android: locked MainActivity to portrait');
}
