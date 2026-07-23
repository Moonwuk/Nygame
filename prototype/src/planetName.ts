/**
 * Авто-имена мирам — как у флотов (fleetName.ts), но для планет: вместо голой
 * сеточной координаты («C2R1») мир получает узнаваемое собственное имя. Полностью
 * ВЫВОДИМО из id планеты (её координаты): один id → одно имя на всех клиентах, без
 * состояния/ядра и без `Math.random`. Координата остаётся отдельно (как обозначение).
 *
 * Формат: `{ИМЯ}-{N}` — латиница (нейтральна к локали, как позывные флотов),
 * мифо-астрономический колорит, номер даёт уникальность при редкой коллизии хэша.
 */

/** Мифо-астрономические собственные имена миров (латиница — нейтральны к локали). */
export const PLANET_NAMES = [
  'HELIOS',
  'CERBERUS',
  'ARCADIA',
  'TARTARUS',
  'EREBUS',
  'PANDORA',
  'AVALON',
  'VALHALLA',
  'OLYMPUS',
  'HYPERION',
  'TRITON',
  'CERES',
  'VESTA',
  'ICARUS',
  'DAEDALUS',
  'PROMETHEUS',
  'ATLAS',
  'KRONOS',
  'RHEA',
  'PHOBOS',
  'DEIMOS',
  'CHARON',
  'STYX',
  'LETHE',
  'MORPHEUS',
  'NYX',
  'GAIA',
  'PONTUS',
  'TETHYS',
  'THEMIS',
  'METIS',
  'SELENE',
  'ASTRAEA',
  'HESPERA',
  'ORION',
  'LYRA',
] as const;

/** Детерминированный 32-битный хэш строки (FNV-1a) — без Math.random. */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Стабильное имя мира `{ИМЯ}-{N}` (N = 1..9) из id планеты (её координаты). */
export function planetName(id: string): string {
  const h = hashStr(id);
  const name = PLANET_NAMES[h % PLANET_NAMES.length]!;
  const num = (Math.floor(h / PLANET_NAMES.length) % 9) + 1;
  return `${name}-${num}`;
}
