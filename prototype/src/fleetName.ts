/**
 * Авто-имена флотам в духе Bytro/Supremacy («2-й Hunter Mech Бригада»): у каждого
 * соединения — узнаваемое имя вместо голого «ФЛОТ». Полностью ВЫВОДИМО из id
 * флота: одна и та же строка id → одно и то же имя на всех клиентах (в сети имя
 * не нужно передавать — все выведут его одинаково), без правки состояния/ядра и
 * без `Math.random`. При слиянии/разделении id меняется — меняется и имя, ровно
 * как у Bytro новое соединение получает новое имя.
 *
 * Формат: `{тип} «{ПОЗЫВНОЙ} {N}»` — тип отражает РАЗМЕР флота (звено < эскадра <
 * армада), позывной латиницей (нейтрален к локали — как «HUNTER MECH» у Bytro
 * даже в русском клиенте), номер даёт уникальность при редкой коллизии хэша.
 * `fleetCallsign` — чистая функция id; `fleetKindKey` — msgid типа по размеру
 * (переводится через `t()` на месте рендера).
 */

/** Латинские кодовые имена — нейтральны к локали, военно-космический колорит. */
export const FLEET_CALLSIGNS = [
  'NEMESIS',
  'VORTEX',
  'HARPOON',
  'OBSIDIAN',
  'COBRA',
  'TITAN',
  'PHALANX',
  'SCORPION',
  'AURORA',
  'HYDRA',
  'RAVEN',
  'SPECTRE',
  'ONYX',
  'VANGUARD',
  'TEMPEST',
  'WARDEN',
  'VIPER',
  'HALCYON',
  'IRONSIDE',
  'NOVA',
  'PALADIN',
  'REVENANT',
  'SABER',
  'ZENITH',
] as const;

/** Детерминированный 32-битный хэш строки (djb2-вариант) — без Math.random. */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Стабильный позывной `{ИМЯ} {N}` (N = 1..9) из id флота. */
export function fleetCallsign(id: string): string {
  const h = hashStr(id);
  const name = FLEET_CALLSIGNS[h % FLEET_CALLSIGNS.length]!;
  const num = (Math.floor(h / FLEET_CALLSIGNS.length) % 9) + 1;
  return `${name} ${num}`;
}

/** Русский msgid типа соединения по числу КОРАБЛЕЙ (десант не считается — тип
 *  отражает боевой хвост). Переводится `t()` на месте вызова. */
export function fleetKindKey(shipCount: number): string {
  if (shipCount <= 2) return 'Звено';
  if (shipCount <= 5) return 'Эскадрилья';
  if (shipCount <= 12) return 'Эскадра';
  if (shipCount <= 25) return 'Флот';
  return 'Армада';
}
