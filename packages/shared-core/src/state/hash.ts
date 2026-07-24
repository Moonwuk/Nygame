import type { GameState } from './gameState';

/**
 * Canonical, deterministic digest of ANY JSON-serializable value — order-
 * independent (object keys are sorted, so two logically-equal values with
 * differently-ordered keys hash the same), pure, and platform-stable (no
 * `Date`, no `Math.random`, no Node built-ins, only integer ops — identical
 * on the server and in the browser). Not cryptographic; it is a fingerprint
 * for detecting divergence/tampering, not a security signature.
 */
export function hashJson(value: unknown): string {
  return digest(stableStringify(value));
}

/**
 * Canonical, deterministic digest of a {@link GameState} — the primitive for
 * desync detection: the server and a client compare `hashState(...)`, and a
 * mismatch means their worlds diverged (force a full resync + alert). This makes
 * "determinism" verifiable instead of assumed (CR-0.3 / sprint-1.md S1.6).
 *
 * It is **not** cryptographic. Two states that are *logically* equal must hash
 * equally even if their object keys were inserted in different orders — e.g. the
 * server holds a state built by `applyAction`, while the client rebuilt the same
 * state by `applyDelta`, which need not preserve key order. So keys are sorted
 * before hashing. Array order is preserved (it is semantically meaningful in the
 * state: schedule order, garrison stacks, lanes, …).
 */
export function hashState(state: GameState): string {
  return hashJson(state);
}

/**
 * Order-independent serialization: object keys are sorted and `undefined`-valued
 * keys are dropped (matching JSON / deep-equal semantics, so `{a:undefined}` and
 * `{}` serialize alike); arrays keep their order; strings are JSON-escaped.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) {
      out += (i > 0 ? ',' : '') + stableStringify(value[i]);
    }
    return out + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    let out = '{';
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i] as string;
      out += (i > 0 ? ',' : '') + JSON.stringify(k) + ':' + stableStringify(obj[k]);
    }
    return out + '}';
  }
  // undefined / function / symbol — never part of a JSON-serializable GameState.
  return 'null';
}

/**
 * cyrb53 — a compact, well-distributed 53-bit non-cryptographic hash. Two 32-bit
 * lanes mixed per UTF-16 code unit, then avalanched. Uses only `Math.imul` and
 * uint32 ops, so it is bit-for-bit identical across JS engines. Returns a fixed
 * 14-char hex string. If the algorithm ever changes, the golden test fails (it
 * invalidates any cross-version hash comparison) — change deliberately.
 */
function digest(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(16).padStart(14, '0');
}
