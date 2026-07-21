// ruleid: core-no-math-random
const roll = Math.random();

// ok: core-no-math-random
function ok(rng: { next(): number }) {
  return rng.next();
}
