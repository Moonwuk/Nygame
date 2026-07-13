import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Rng, seedRng, parseMatchMap, type MatchMap } from '@void/shared-core';
import { pickAvaMap } from './avaMapPool';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readMap = (name: string): MatchMap =>
  parseMatchMap(JSON.parse(readFileSync(path.join(repoRoot, 'data/maps', name), 'utf8')));

const shipped = (): MatchMap[] => [
  readMap('skirmish-1.json'),
  readMap('ava-duel-1.json'),
  readMap('ava-2v2-1.json'),
];
const rng = (seed: string): Rng => new Rng(seedRng(seed));

describe('pickAvaMap (AVA-5) — the AvA map pool', () => {
  it('answers "an AvA map for N×M" from the shipped maps: 2×1 → duel, 2×2 → the 2v2 map', () => {
    expect(pickAvaMap(shipped(), 2, 1, rng('s'))?.id).toBe('ava-duel-1');
    expect(pickAvaMap(shipped(), 2, 2, rng('s'))?.id).toBe('ava-2v2-1');
  });

  it('returns null when no eligible map matches the requested size', () => {
    expect(pickAvaMap(shipped(), 3, 1, rng('s'))).toBeNull();
    expect(pickAvaMap([], 2, 1, rng('s'))).toBeNull();
  });

  it('never picks a map that is not tagged eligible, even if its shape matches', () => {
    const untagged = readMap('ava-duel-1.json');
    untagged.avaEligible = false;
    expect(pickAvaMap([untagged], 2, 1, rng('s'))).toBeNull();
  });

  it('is deterministic: same pool + same seed → the same map, whatever the array order', () => {
    const a = readMap('ava-duel-1.json');
    const b = { ...readMap('ava-duel-1.json'), id: 'ava-duel-2' };
    const c = { ...readMap('ava-duel-1.json'), id: 'ava-duel-3' };
    const pick1 = pickAvaMap([a, b, c], 2, 1, rng('match-42'))!;
    const pick2 = pickAvaMap([c, a, b], 2, 1, rng('match-42'))!;
    expect(pick1.id).toBe(pick2.id);
    // any seed stays within the candidate pool
    const ids = new Set(['ava-duel-1', 'ava-duel-2', 'ava-duel-3']);
    for (const s of ['x', 'y', 'z']) {
      expect(ids.has(pickAvaMap([a, b, c], 2, 1, rng(s))!.id)).toBe(true);
    }
  });
});
