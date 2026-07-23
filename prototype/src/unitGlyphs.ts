/**
 * Ship-type visual system (постер владельца, 2026-07-22): «цвет = чей ·
 * силуэт = что · всё выводимо из данных». Шесть архетипов-силуэтов, роль
 * выводится из полей unit-def; цвет остаётся за вызывающим (принадлежность
 * стороны), силуэт несёт ТИП — каналы не конфликтуют, читается и при
 * дальтонизме, и на 16 px.
 *
 * Чистое отображение данные → глиф: без DOM и канвы. Один нормализованный
 * SVG-путь (вьюбокс 24×24, нос вверх) кормит и тайлы панели (<svg><path>), и
 * маркеры карты (new Path2D(path) + fill(path,'evenodd')).
 */
import type { GameData, UnitDef, UnitStack } from '../../packages/shared-core/src/index';

export type ShipArchetype = 'scout' | 'combat' | 'artillery' | 'transport' | 'flagship' | 'swarm';

/** cargoCapacity с этого порога читается как выделенный транспортник
 *  (постер: «высокий cargoCapacity»; dropship 8 — да, cruiser 5 — нет). */
export const TRANSPORT_CARGO_MIN = 8;

/** Роль корабля из полей unit-def — порядок проверок фиксирует приоритет
 *  (флагман > артиллерия > рой > транспорт > скаут > боевой по умолчанию). */
export function unitArchetype(def: UnitDef): ShipArchetype {
  if (def.traits.includes('hero')) return 'flagship';
  if (def.traits.includes('artillery') || (def.stats.range ?? 0) > 0) return 'artillery';
  if (def.faction === 'swarm') return 'swarm';
  if ((def.stats.cargoCapacity ?? 0) >= TRANSPORT_CARGO_MIN) return 'transport';
  if ((def.signature ?? 1) <= 1 && (def.radarRange ?? 0) > 0) return 'scout';
  return 'combat';
}

export type GlyphSize = 'S' | 'M' | 'L';

/** Модификатор размера S/M/L по ХП корпуса за корабль (постер: «размер по hp»).
 *  Пороги по прототип-ростеру: скаут/эскадрилья 10–12 → S, крейсер/десантник
 *  50–70 → M, герой 180 → L. */
export function unitSizeClass(hp: number): GlyphSize {
  return hp >= 90 ? 'L' : hp >= 30 ? 'M' : 'S';
}

/** Нормализованные силуэты, 24×24, нос вверх. Многосоставные пути рисуются с
 *  fill-rule='evenodd' (в канве — fill(path2d, 'evenodd')). */
export const ARCHETYPE_PATH: Record<ShipArchetype, string> = {
  // тонкая стрела с вырезом у хвоста — низкая сигнатура
  scout: 'M12 2 L16.5 21 L12 16.5 L7.5 21 Z',
  // широкая дельта с крыльями — front-line
  combat: 'M12 2 L18.5 20.5 L14.5 18.5 L12 21.5 L9.5 18.5 L5.5 20.5 Z',
  // ствол мортиры над клином-лафетом
  artillery: 'M10.8 2.5 h2.4 v7 h-2.4 Z M6.5 11 h11 L15 21.5 h-6 Z',
  // шестигранный контейнеровоз
  transport: 'M8 5.5 h8 l3.5 6.5 l-3.5 6.5 h-8 l-3.5 -6.5 Z',
  // дельта флагмана — гало-кольцо дорисовывает рендерер (пунктирная орбита)
  flagship: 'M12 1.5 L19.5 20 L14.8 17.6 L12 21.5 L9.2 17.6 L4.5 20 Z',
  // пятилучевая звезда — семейство-органика
  swarm:
    'M12 2 L14.6 8.8 L21.8 9.2 L16.2 13.8 L18.1 20.8 L12 16.8 L5.9 20.8 L7.8 13.8 L2.2 9.2 L9.4 8.8 Z',
};

export interface GlyphOpts {
  /** Цвет стороны (принадлежность) — единственный канал цвета. */
  color: string;
  /** Сторона квадратного бокса в css px (по умолчанию 22). */
  px?: number;
  /** Гало-кольцо «есть щит» (постер: модификатор поверх силуэта). */
  shield?: boolean;
  /** Фракц-акцент — короткий штрих под силуэтом (штрих, не hue). */
  accent?: string;
}

/** DOM-глиф для тайлов панели: силуэт по архетипу + модификаторы постера
 *  (размер S/M/L по hp, гало при щите, у флагмана — всегда пунктирная орбита). */
export function unitGlyphSvg(def: UnitDef, o: GlyphOpts): string {
  const arch = unitArchetype(def);
  const size = unitSizeClass(def.stats.hp ?? 0);
  const box = o.px ?? 22;
  // S/M/L — масштаб силуэта внутри неизменного бокса, чтобы сетка тайлов не плыла.
  const k = size === 'L' ? 1 : size === 'M' ? 0.84 : 0.68;
  const halo = o.shield || arch === 'flagship';
  const ring = halo
    ? `<circle cx="12" cy="12" r="10.6" fill="none" stroke="${o.color}" stroke-width="1.1" stroke-dasharray="2.4 2.7" opacity="0.75"/>`
    : '';
  const accent = o.accent
    ? `<path d="M7.5 22.6 h9" stroke="${o.accent}" stroke-width="1.6" fill="none"/>`
    : '';
  const tf =
    k === 1
      ? ''
      : ` transform="translate(${(12 * (1 - k)).toFixed(2)} ${(12 * (1 - k)).toFixed(2)}) scale(${k})"`;
  return (
    `<svg class="uglyph" viewBox="0 0 24 24" width="${box}" height="${box}" aria-hidden="true">` +
    ring +
    `<g${tf}><path d="${ARCHETYPE_PATH[arch]}" fill="${o.color}" fill-rule="evenodd" stroke="rgba(4,10,12,.8)" stroke-width="0.8"/></g>` +
    accent +
    `</svg>`
  );
}

/** «Сильнейший корабль» флота для маркера карты (постер: флот на карте =
 *  доминант + счёт): максимум по attack+defense, тай-брейки hp ↓ и id ↑ —
 *  детерминированно при любом порядке стеков. Наземные и пустые стеки не
 *  участвуют; флот без кораблей → null. */
export function dominantUnit(
  stacks: readonly UnitStack[],
  data: GameData,
): { unit: string; def: UnitDef } | null {
  let best: { unit: string; def: UnitDef; power: number; hp: number } | null = null;
  for (const s of stacks) {
    if (s.count <= 0) continue;
    const def = data.units[s.unit];
    if (!def || def.domain === 'ground') continue;
    const power = (def.stats.attack ?? 0) + (def.stats.defense ?? 0);
    const hp = def.stats.hp ?? 0;
    if (
      !best ||
      power > best.power ||
      (power === best.power && (hp > best.hp || (hp === best.hp && s.unit < best.unit)))
    ) {
      best = { unit: s.unit, def, power, hp };
    }
  }
  return best ? { unit: best.unit, def: best.def } : null;
}
