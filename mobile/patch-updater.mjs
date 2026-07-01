// Wire the in-app one-tap updater into the freshly-generated Android project.
//
// Runs AFTER `cap add android` / `cap sync` / brand / patch-android.mjs, and is
// idempotent + defensive: the android/ project is gitignored and regenerated every
// build, and we cannot run the Android SDK in dev, so each step checks before it edits
// and tolerates whatever Capacitor's template already provides.
//
// It does two things:
//   1. MainActivity.java — replace with a version that exposes window.VoidNative.open(url),
//      a tiny bridge handing the update APK's URL to the SYSTEM BROWSER (which downloads it
//      and offers to install). No install permission / DownloadManager / FileProvider — that
//      earlier in-app-install path proved unreliable across devices and was dropped, so the
//      manifest no longer needs REQUEST_INSTALL_PACKAGES or a file-paths provider either.
//   2. app/build.gradle — stamp versionCode/versionName (from env VOID_VC / VOID_VN) so
//      Android treats each rolling build as a strictly newer update.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const read = (p) => readFileSync(p, 'utf8');

const appId = JSON.parse(read(here('./capacitor.config.json'))).appId;
if (!appId) throw new Error('patch-updater: appId missing from capacitor.config.json');
const pkgPath = appId.replace(/\./g, '/');

const mainActivityPath = here(`./android/app/src/main/java/${pkgPath}/MainActivity.java`);
const buildGradlePath = here('./android/app/build.gradle');

// --- 1. MainActivity.java ---------------------------------------------------
{
  const java = `package ${appId};

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;

/**
 * Capacitor host activity + a tiny native bridge for the in-app updater.
 *
 * The earlier build tried to download AND install the update APK itself (a WebView
 * DownloadListener → DownloadManager → FileProvider install intent). That path proved
 * unreliable across devices (the auto-launched installer often never appeared). The
 * updater now does the robust thing instead: it hands the APK asset URL to the SYSTEM
 * BROWSER via window.VoidNative.open(url). The browser downloads it and offers to install
 * from the download — which works everywhere, with no DownloadManager/FileProvider
 * plumbing or extra install permission to misfire.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Exposed to the bundled web app (local content only) as window.VoidNative.
        this.bridge.getWebView().addJavascriptInterface(new UpdaterBridge(getApplicationContext()), "VoidNative");
    }

    public static class UpdaterBridge {
        private final Context ctx;
        UpdaterBridge(Context c) {
            this.ctx = c;
        }

        /** Open a URL in the external browser (used to fetch the update APK). */
        @JavascriptInterface
        public void open(String url) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
            } catch (Exception ignored) {
                // The web layer keeps a plain-link fallback, so nothing more to do here.
            }
        }
    }
}
`;
  if (!existsSync(mainActivityPath)) {
    throw new Error(`patch-updater: MainActivity not found at ${mainActivityPath}`);
  }
  writeFileSync(mainActivityPath, java);
  console.log('patch-updater: MainActivity.java — installed the VoidNative browser-open bridge.');
}

// --- 2. app/build.gradle (versionCode / versionName) ------------------------
{
  const vc = process.env.VOID_VC;
  const vn = process.env.VOID_VN;
  if (!vc || !/^\d+$/.test(vc)) {
    console.log('patch-updater: VOID_VC unset/invalid — leaving build.gradle versionCode as-is.');
  } else {
    let gradle = read(buildGradlePath);
    if (!/versionCode\s+\d+/.test(gradle)) {
      // Check presence (not whether a change happened): on a re-run the value may already
      // equal the target, which is a successful no-op, not a missing-anchor failure.
      throw new Error('patch-updater: could not find versionCode in app/build.gradle');
    }
    gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${vc}`);
    if (vn) gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${vn}"`);
    writeFileSync(buildGradlePath, gradle);
    console.log(`patch-updater: build.gradle — versionCode ${vc}${vn ? ` / versionName "${vn}"` : ''}.`);
  }
}
