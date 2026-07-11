import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from './locale/en';

// Locale-coverage guard (BF: EN leak). The canonical language is Russian — every
// `t('…')` msgid and every static `[data-i18n]` header is a Russian source string,
// and en.ts translates it. A missing entry silently shows Russian on the English
// locale (an honest fallback, but a bug in shipped UI). These tests pin the full
// coverage so a NEW untranslated string fails CI instead of leaking to playtesters.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string): string => readFileSync(path.join(repoRoot, p), 'utf8');
const hasCyrillic = (s: string): boolean => /[А-Яа-яЁё]/.test(s);

/** Extract the first string-literal argument of every `t(…)` call. Walks char by
 *  char (no regex fragility on `{placeholders}` / apostrophes / newlines): on a `t`
 *  that opens a call, read the quoted literal, honoring backslash escapes. */
function extractTMsgids(src: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < src.length - 1; i++) {
    if (src[i] !== 't' || src[i + 1] !== '(') continue;
    const prev = i > 0 ? src[i - 1] : ' ';
    if (/[A-Za-z0-9_$.]/.test(prev)) continue; // part of a longer identifier / member
    let j = i + 2;
    while (j < src.length && /\s/.test(src[j]!)) j++;
    const q = src[j];
    if (q !== "'" && q !== '"' && q !== '`') continue;
    j++;
    let lit = '';
    while (j < src.length) {
      const c = src[j]!;
      if (c === '\\') {
        lit += c + (src[j + 1] ?? '');
        j += 2;
        continue;
      }
      if (c === q) break;
      lit += c;
      j++;
    }
    out.add(
      lit
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\`/g, '`')
        .replace(/\\n/g, '\n')
        .replace(/\\\\/g, '\\'),
    );
  }
  return out;
}

/** Static markup msgids in build.mjs: [data-i18n] element TEXT (canonical Russian),
 *  plus title/placeholder/aria-label VALUES flagged by the -title/-ph/-aria variants. */
function extractDomMsgids(src: string): Set<string> {
  const out = new Set<string>();
  const pairs: Array<[RegExp]> = [
    [/data-i18n-title[^>]*?\btitle="([^"]+)"/g],
    [/\btitle="([^"]+)"[^>]*?data-i18n-title/g],
    [/data-i18n-ph[^>]*?\bplaceholder="([^"]+)"/g],
    [/\bplaceholder="([^"]+)"[^>]*?data-i18n-ph/g],
    [/data-i18n-aria[^>]*?\baria-label="([^"]+)"/g],
    [/\baria-label="([^"]+)"[^>]*?data-i18n-aria/g],
    [/<[^>]*\bdata-i18n\b[^>]*>([^<]+)</g],
  ];
  for (const [re] of pairs) {
    for (const m of src.matchAll(re)) {
      const txt = m[1]!.trim();
      if (txt) out.add(txt);
    }
  }
  return out;
}

describe('i18n — the English locale covers every UI string (no Russian leak)', () => {
  it('every t() msgid in main.ts / game.ts has an English entry', () => {
    const src = read('prototype/src/main.ts') + '\n' + read('prototype/src/game.ts');
    const missing = [...extractTMsgids(src)].filter((m) => !(m in en)).sort();
    expect(missing, `untranslated t() msgids: ${JSON.stringify(missing, null, 2)}`).toEqual([]);
  });

  it('every static [data-i18n] header in build.mjs has an English entry', () => {
    const src = read('prototype/build.mjs');
    const missing = [...extractDomMsgids(src)]
      .filter((m) => hasCyrillic(m) && !(m in en))
      .sort();
    expect(missing, `untranslated [data-i18n]: ${JSON.stringify(missing, null, 2)}`).toEqual([]);
  });

  it('no reverse-leak: an English value never stays Russian (nor copies a Russian source)', () => {
    // A language-NEUTRAL msgid (no Cyrillic, e.g. '{got}/{need} XP') legitimately maps
    // to itself — flag only a value that still carries Russian, or a Russian source
    // copied verbatim into its own translation.
    const leaks = Object.entries(en)
      .filter(([k, v]) => !k.startsWith('data:') && (hasCyrillic(v) || (k === v && hasCyrillic(k))))
      .map(([k]) => k);
    expect(leaks, `Russian left in EN values: ${JSON.stringify(leaks, null, 2)}`).toEqual([]);
  });
});
