import {
  parseArsenalItem,
  validateArsenalItem,
  type ArsenalItem,
  type GameData,
  type PlayerArsenal,
} from '@void/shared-core';
import type { ArsenalStore } from './store';

/**
 * ARS-2 — the starter arsenal: every fresh account owns a small blueprint set from
 * its first second, so "an empty arsenal" never exists as a state (the same lesson
 * as the one-tap scientist pick: a first choice must never be a wall of empty
 * slots). The set itself is DATA (`data/starterArsenal.json`) — balancing it is a
 * JSON edit, not code.
 *
 * Grant rules:
 *  - item ids are deterministic (`starter:<accountId>:<kind>:<defId>`), and the
 *    store's grant is idempotent by id — a replayed registration (or a re-run of
 *    the grant after a crash) can never duplicate the set;
 *  - everything is a SOULBOUND blueprint: tradable starter items would make
 *    registration farming a mint for the auction (anti-abuse; ARS-0 anti-RMT).
 */

/** One line of `data/starterArsenal.json` — the template the grant stamps per account. */
export interface StarterArsenalTemplate {
  kind: ArsenalItem['kind'];
  defId: string;
}

/** Validate the starter templates against the shipped catalogs (fail-secure at
 *  boot: a template referencing content that does not ship refuses to load). */
export function validateStarterArsenal(
  templates: readonly StarterArsenalTemplate[],
  data: GameData,
): string[] {
  const issues: string[] = [];
  for (const t of templates) {
    const item = parseArsenalItem({ itemId: `starter:template:${t.kind}:${t.defId}`, ...t });
    issues.push(...validateArsenalItem(item, data));
  }
  return issues;
}

/** Project an account's owned items into the `Player.arsenal` snapshot shape
 *  (ARS-3): unique, sorted catalog ids per kind — blueprints and instances alike
 *  grant buildability (the hybrid ARS-0 model; instance-specific state like grade
 *  stays meta-side until per-item install lands with EC-2). Pure. */
export function arsenalSnapshotOf(items: readonly ArsenalItem[]): PlayerArsenal {
  const pick = (kind: ArsenalItem['kind']): string[] =>
    [...new Set(items.filter((i) => i.kind === kind).map((i) => i.defId))].sort();
  return { hulls: pick('hull'), modules: pick('module'), fittings: pick('hero_fitting') };
}

/** ARS-6 — merge a corp-rental snapshot into a personal one: the union per kind,
 *  sorted/deduped (same shape `arsenalSnapshotOf` produces). Pure. A rented hull/
 *  module builds exactly like an owned one — the core gate doesn't distinguish
 *  "mine" from "borrowed for this war" (both live in the one `PlayerArsenal`). */
export function mergeArsenal(a: PlayerArsenal, b: PlayerArsenal): PlayerArsenal {
  const union = (x: string[], y: string[]): string[] => [...new Set([...x, ...y])].sort();
  return {
    hulls: union(a.hulls, b.hulls),
    modules: union(a.modules, b.modules),
    fittings: union(a.fittings, b.fittings),
  };
}

/** Grant the starter set to an account — idempotent end to end (deterministic item
 *  ids + the store's first-write-wins grant), so calling it twice, or replaying a
 *  registration, changes nothing. Returns the granted item count (the full set). */
export async function grantStarterArsenal(
  store: ArsenalStore,
  accountId: string,
  templates: readonly StarterArsenalTemplate[],
  now: number,
): Promise<number> {
  for (const t of templates) {
    await store.grant({
      itemId: `starter:${accountId}:${t.kind}:${t.defId}`,
      accountId,
      kind: t.kind,
      form: 'blueprint',
      defId: t.defId,
      soulbound: true, // starter items never trade — registration farming mints nothing
      origin: 'starter',
      acquiredAt: now,
    });
  }
  return templates.length;
}
