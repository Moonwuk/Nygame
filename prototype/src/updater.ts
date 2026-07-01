// In-app APK auto-update for the sideloaded Android build.
//
// This is DORMANT in the browser / dev build: only the packaged APK carries a baked
// build identity (`window.__BUILD__`, injected into index.html at package time by CI —
// see mobile/inject-build.mjs). In the browser the content is always live, so there is
// nothing to update and every entry point below short-circuits to "no update".
//
// Flow (APK only):
//   1. read our own build  → window.__BUILD__ = { versionCode, sha }
//   2. fetch the rolling "alpha" GitHub release via the CORS-enabled REST API
//      (api.github.com sends Access-Control-Allow-Origin: *, so the WebView can read it;
//       the release *asset* download endpoints do not, which is why we read the version
//       out of the release BODY rather than fetching a separate version.json asset)
//   3. compare versionCode → if the release is strictly newer, surface it
//   4. "Обновить" navigates the WebView to the APK asset URL. GitHub serves the asset
//      with Content-Disposition: attachment, so the WebView treats it as a download and
//      fires the native DownloadListener (MainActivity), which downloads it and launches
//      the system installer. Outside the APK that navigation is just a browser download.
//
// CI bakes a monotonic versionCode (commit count) and the short SHA into BOTH the APK
// (mobile/patch-updater.mjs → build.gradle) and the release body marker, so the running
// build and the published build are compared on the same integer.

export interface BuildInfo {
  /** Monotonic Android versionCode (commit count at build time). */
  versionCode: number;
  /** Short git SHA, for display ("alpha-<sha>"). */
  sha: string;
}

export interface UpdateInfo extends BuildInfo {
  /** Direct download URL of the rolling release's APK asset. */
  apkUrl: string;
  /** Full release body (shown to the player as "what's new"). */
  notes: string;
}

/** Rolling "alpha" prerelease — a stable tag whose APK asset URL never changes. */
const RELEASE_API = 'https://api.github.com/repos/moonwuk/nygame/releases/tags/alpha';
const APK_ASSET = 'void-dominion-alpha.apk';

/**
 * The APK download must come from GitHub's own release-asset hosts over HTTPS. The version
 * check reads a URL out of the release JSON and hands it to the system browser to install;
 * this allowlist means a tampered/malformed release body can't redirect the install to an
 * arbitrary origin. (The release JSON already arrives over a TLS-validated api.github.com
 * connection — this is defense-in-depth on the one value we then act on.)
 */
export function isTrustedApkUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return (
    h === 'github.com' ||
    h.endsWith('.github.com') ||
    h === 'githubusercontent.com' ||
    h.endsWith('.githubusercontent.com')
  );
}

interface GlobalWithBuild {
  __BUILD__?: { versionCode?: unknown; sha?: unknown };
}

/** Our own build identity, injected into the APK's index.html at package time. */
export function currentBuild(): BuildInfo | null {
  const b = (globalThis as GlobalWithBuild).__BUILD__;
  if (!b || typeof b.versionCode !== 'number' || !Number.isFinite(b.versionCode)) return null;
  return { versionCode: b.versionCode, sha: typeof b.sha === 'string' ? b.sha : '' };
}

interface ReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

/**
 * Parse the GitHub release JSON into the fields we need, or null if it is unusable.
 * The versionCode is read from a machine marker the build embeds in the release body
 * (`void:versionCode=<n>`); the APK URL from the asset named `void-dominion-alpha.apk`.
 */
export function parseRelease(release: unknown): UpdateInfo | null {
  if (!release || typeof release !== 'object') return null;
  const r = release as { body?: unknown; assets?: unknown };
  const body = typeof r.body === 'string' ? r.body : '';

  const vcMatch = /void:versionCode=(\d+)/.exec(body) ?? /versionCode[^\d]{0,6}(\d+)/i.exec(body);
  if (!vcMatch) return null;
  const versionCode = Number(vcMatch[1]);
  if (!Number.isFinite(versionCode)) return null;

  const shaMatch = /void:sha=([0-9a-f]+)/i.exec(body) ?? /\b([0-9a-f]{7,40})\b/.exec(body);
  const sha = shaMatch ? shaMatch[1]! : '';

  const assets: ReleaseAsset[] = Array.isArray(r.assets) ? (r.assets as ReleaseAsset[]) : [];
  const apk = assets.find(
    (a) => !!a && a.name === APK_ASSET && typeof a.browser_download_url === 'string',
  );
  if (!apk) return null;

  // Only trust an asset URL served from GitHub over HTTPS — never redirect an install elsewhere.
  const apkUrl = apk.browser_download_url as string;
  if (!isTrustedApkUrl(apkUrl)) return null;

  return { versionCode, sha, apkUrl, notes: body };
}

/** True when `remote` is a strictly newer build than `local`. */
export function isNewer(local: BuildInfo, remote: UpdateInfo): boolean {
  return remote.versionCode > local.versionCode;
}

/**
 * Check the rolling release for a newer build. Returns the update if one is available,
 * else null — and null on EVERY failure path (no baked build = browser/dev, offline,
 * rate-limited, bad JSON, older-or-equal release). The updater must never throw into the
 * boot path, so all errors collapse to "no update".
 */
export async function checkForUpdate(fetchImpl: typeof fetch = fetch): Promise<UpdateInfo | null> {
  const r = await checkForUpdateDetailed(fetchImpl);
  return r.kind === 'update' ? r.info : null;
}

/**
 * Every distinct outcome of an update check, so the UI can tell "you're up to date" apart
 * from "the check failed" (they used to collapse to the same null). Powers the manual
 * "Проверить обновления" diagnostic.
 */
export type UpdateCheck =
  | { kind: 'dormant' } // no baked build (browser / dev) — nothing to update
  | { kind: 'offline'; error: string } // fetch threw (no network / VPN / DNS)
  | { kind: 'http'; status: number } // reached GitHub but it answered non-2xx
  | { kind: 'unparsable' } // got a response we couldn't read a version out of
  | { kind: 'current'; local: number; remote: number } // already on the newest build
  | { kind: 'update'; info: UpdateInfo; local: number }; // a newer build is available

export async function checkForUpdateDetailed(fetchImpl: typeof fetch = fetch): Promise<UpdateCheck> {
  const local = currentBuild();
  if (!local) return { kind: 'dormant' };
  let res: Response;
  try {
    res = await fetchImpl(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
  } catch (e) {
    return { kind: 'offline', error: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { kind: 'http', status: res.status };
  let remote: UpdateInfo | null;
  try {
    remote = parseRelease(await res.json());
  } catch {
    remote = null;
  }
  if (!remote) return { kind: 'unparsable' };
  return isNewer(local, remote)
    ? { kind: 'update', info: remote, local: local.versionCode }
    : { kind: 'current', local: local.versionCode, remote: remote.versionCode };
}

/** Human label for a build ("alpha-1a2b3c4", or "сборка N" when no SHA). */
export function buildLabel(b: BuildInfo): string {
  return b.sha ? `alpha-${b.sha}` : `сборка ${b.versionCode}`;
}
