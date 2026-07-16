import { z } from 'zod';
import type { GameData } from './schemas';

/**
 * Arsenal item schema (ARS-1, `arsenal-roadmap.md`) — the data model of what an
 * ACCOUNT owns between sessions: ship hulls, modules and hero fittings, each as a
 * blueprint or a unique instance. Validated here before it ever reaches a store or
 * a match snapshot (OWASP A05/A08), exactly like maps and the game-content bundle.
 *
 * The deterministic core never reads the arsenal — ownership lives on the server
 * (`ArsenalStore`, ARS-2) and reaches a match only through the `SlotAssignment`
 * snapshot (ARS-3) or the live build gate (LARS-1). This schema is the shared
 * contract all of them (and the EC-* auction/lootboxes/craft) speak.
 *
 * Owner resolutions (ARS-0, 2026-07-14) the shape encodes:
 *  - HYBRID model: `form: 'blueprint'` = unlocked forever, build for session
 *    resources (hulls + base modules); `form: 'instance'` = a unique, tradable
 *    item (rare/upgraded modules, EC-2.1) — only instances carry `grade` and
 *    `durability` (the rent-wear sink, ARS-6).
 *  - No full-loot: nothing here models in-match loss.
 *  - `soulbound` marks donat/lootbox items as untradable (anti-RMT, GDD §4.4).
 */

/** What the item references in the game-data catalogs. */
export const ArsenalItemKindSchema = z.enum(['hull', 'module', 'hero_fitting']);

/** Blueprint = a permanent unlock (build for session resources); instance = one
 *  unique, tradable item (ARS-0.1 — the hybrid model). */
export const ArsenalItemFormSchema = z.enum(['blueprint', 'instance']);

/** How the item entered the arsenal (drop tables / audit / anti-RMT read this). */
export const ArsenalOriginSchema = z.enum([
  'starter',
  'drop',
  'craft',
  'auction',
  'lootbox',
  'rent',
]);

/** Upgrade grades (EC-2.1: заточка +1/+2/+3). */
const GRADE_MAX = 3;

export const ArsenalItemSchema = z
  .object({
    /** Unique item id (an instance's identity; a blueprint's stable unlock id). */
    itemId: z.string().min(1),
    kind: ArsenalItemKindSchema,
    form: ArsenalItemFormSchema.default('blueprint'),
    /** Catalog reference: hull → `data.units`, module → `data.modules`,
     *  hero_fitting → `data.heroFittings`. Existence is checked against a real
     *  bundle by {@link validateArsenalItem} (fail-secure on an unknown id). */
    defId: z.string().min(1),
    /** Upgrade grade (EC-2.1, +1..+3) — instances only. */
    grade: z.number().int().min(1).max(GRADE_MAX).optional(),
    /** Untradable (donat/lootbox anti-RMT, GDD §4.4). Earned/crafted items trade. */
    soulbound: z.boolean().default(false),
    /** Remaining wear (the corp-rent sink, ARS-6) — instances only. Absent = the
     *  item does not wear. */
    durability: z.number().int().nonnegative().optional(),
    origin: ArsenalOriginSchema.default('starter'),
    acquiredAt: z.number().default(0),
  })
  .superRefine((item, ctx) => {
    // The hybrid rule (ARS-0.1): per-item state belongs to INSTANCES only — a
    // blueprint is a permanent unlock and carries neither grade nor wear.
    if (item.form === 'blueprint' && item.grade !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['grade'], message: 'grade is instance-only' });
    }
    if (item.form === 'blueprint' && item.durability !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['durability'],
        message: 'durability is instance-only',
      });
    }
  });

export type ArsenalItemKind = z.infer<typeof ArsenalItemKindSchema>;
export type ArsenalItemForm = z.infer<typeof ArsenalItemFormSchema>;
export type ArsenalOrigin = z.infer<typeof ArsenalOriginSchema>;
export type ArsenalItem = z.infer<typeof ArsenalItemSchema>;

/** Strict parse — throws on a malformed item (use at trusted boot/seed). */
export function parseArsenalItem(raw: unknown): ArsenalItem {
  return ArsenalItemSchema.parse(raw);
}

/** Non-throwing parse — for validating untrusted input before use (A05/A08). */
export function safeParseArsenalItem(raw: unknown): z.ZodSafeParseResult<ArsenalItem> {
  return ArsenalItemSchema.safeParse(raw);
}

/** Catalog validation of an already-parsed item: its `defId` must exist in the
 *  bundle's catalog for its `kind`. Returns stable issue codes (empty = valid),
 *  the same contract as `validateMatchMap` — a store/gate rejects on any
 *  (fail-secure: an item referencing content this match doesn't ship is never
 *  granted, snapshotted or built). */
export function validateArsenalItem(item: ArsenalItem, data: GameData): string[] {
  const catalog =
    item.kind === 'hull' ? data.units : item.kind === 'module' ? data.modules : data.heroFittings;
  return catalog[item.defId] ? [] : [`E_UNKNOWN_DEF:${item.kind}:${item.defId}`];
}
