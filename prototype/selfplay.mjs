// M4 self-play balance harness (docs/metrics-roadmap.md): AI vs AI on the REAL
// kernel, headless, seeded, deterministic — N matches → a balance table in one
// command. Mirrors the netserver driver loop (advance the clock, let each seat's
// AI issue orders every ~2 game-hours) with no server/network/DOM at all.
//
//   pnpm run selfplay            # 20 matches, base seed "sp"
//   pnpm run selfplay 200        # 200 matches
//   pnpm run selfplay 200 tag7   # 200 matches, another seed family
//
// Fairness controls per match index i: starts swap on i%2, factions swap on
// (i>>1)%2 — so "win rate by slot", "by faction" and "by start" separate cleanly.
import { build } from 'esbuild';

const N = Math.max(1, Number(process.argv[2] ?? 20) || 20);
const BASE_SEED = process.argv[3] ?? 'sp';

const res = await build({
  entryPoints: ['prototype/src/game.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2020',
  write: false,
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', res.outputFiles[0].text)(mod, mod.exports, () => ({}));
const { newGame, kernel, data, SCORE_LIMIT, aiOrders, HOUR, DAY, START_CANDIDATES } = mod.exports;

const STEP = 2 * HOUR; // the AI decision cadence (mirrors the netserver driver)
const CAP = 90 * DAY; // harness safety net — victory's own timeout fires first (below)

// `endsAt` = the session's forced finale ranked by score (victory module 'timeout') —
// a stalemated war ends with a winner instead of a harness draw, like a real session.
const config = { timeScale: 1, victory: { scoreLimit: SCORE_LIMIT, endsAt: 60 * DAY } };
const ctx = (now) => ({ now, data, config });

function leaderByPlanets(state) {
  const counts = {};
  for (const p of Object.values(state.planets)) {
    if (p.owner) counts[p.owner] = (counts[p.owner] ?? 0) + 1;
  }
  let best = null;
  let bestN = -1;
  let tied = false;
  for (const [owner, n] of Object.entries(counts)) {
    if (n > bestN) {
      best = owner;
      bestN = n;
      tied = false;
    } else if (n === bestN) tied = true;
  }
  return tied ? null : best;
}

function runMatch(i) {
  const swapStart = i % 2 === 1;
  const swapFaction = (i >> 1) % 2 === 1;
  const starts = swapStart
    ? [START_CANDIDATES[1], START_CANDIDATES[0]]
    : [START_CANDIDATES[0], START_CANDIDATES[1]];
  const factions = swapFaction ? ['red', 'blue'] : ['blue', 'red'];
  const seats = [
    { id: 'p1', name: 'Bot One', faction: factions[0], start: starts[0], ai: true },
    { id: 'p2', name: 'Bot Two', faction: factions[1], start: starts[1], ai: true },
  ];
  let state = newGame({ seats, seed: `${BASE_SEED}-${i}` });

  const usage = new Map(); // built unit/building -> count
  let battles = 0;
  let firstCombatAt = null;
  const consume = (events, now) => {
    for (const e of events) {
      if (e.type === 'unit.built') {
        const p = e.payload ?? {};
        usage.set(p.unit, (usage.get(p.unit) ?? 0) + (p.count ?? 1));
      } else if (e.type === 'building.constructed') {
        const p = e.payload ?? {};
        usage.set(p.building, (usage.get(p.building) ?? 0) + 1);
      } else if (e.type === 'battle.resolved') battles++;
      else if (e.type === 'battle.started' && firstCombatAt === null) firstCombatAt = now;
    }
  };

  const leaderTrail = []; // sampled (t, leader-by-planets) — the snowball input
  let now = 0;
  // Seat-order coin, seeded per match (first-mover fairness WITH variance): a fixed
  // order handed p1 75% of matches, and a strict alternation is still one global
  // script — every seed replayed the same game, so "win rates" were binary. A
  // seed-hashed coin per step keeps runs reproducible while different seeds explore
  // different order interleavings — rates become rates.
  let coin = 0;
  for (const ch of `${BASE_SEED}-${i}`) coin = (coin * 31 + ch.charCodeAt(0)) >>> 0;
  const reversedAt = (step) => (((coin ^ Math.imul(step, 2654435761)) >>> 16) & 1) === 1;
  let stepIdx = 0;
  while (now < CAP && state.match.status !== 'ended') {
    now += STEP;
    // catch the world up (chunked — a partial advance keeps making progress)
    for (let c = 0; c < 10; c++) {
      const r = kernel.advanceTo(state, ctx(now));
      if (!r.ok) return { error: r.code };
      state = r.state;
      consume(r.events, now);
      if (!r.partial) break;
      if (r.state.time <= state.time && c > 0) break; // same-instant runaway — bail
    }
    if (state.match.status === 'ended') break;
    // Each seat's AI issues its orders through the same pure reducer; the iteration
    // order per step comes from the seeded coin (see above).
    const seatsInOrder = Object.keys(state.players);
    if (reversedAt(stepIdx)) seatsInOrder.reverse();
    stepIdx += 1;
    for (const seat of seatsInOrder) {
      for (const a of aiOrders(state, seat, 'expand')) {
        const r = kernel.applyAction(state, a, ctx(now));
        if (r.ok) {
          state = r.state;
          consume(r.events, now);
        }
      }
    }
    leaderTrail.push({ t: now, leader: leaderByPlanets(state) });
  }

  const winner = state.match.status === 'ended' ? (state.match.winner ?? null) : null;
  // snowball input: who led (by planets) at the halfway point of THIS match
  const half = state.time / 2;
  let midLeader = null;
  for (const s of leaderTrail) {
    if (s.t <= half) midLeader = s.leader;
    else break;
  }
  const seatMeta = Object.fromEntries(seats.map((s) => [s.id, s]));
  return {
    winner,
    winnerFaction: winner ? seatMeta[winner]?.faction : null,
    winnerStart: winner ? seatMeta[winner]?.start : null,
    lengthMs: state.time,
    reason: state.match.reason,
    battles,
    firstCombatAt,
    midLeader,
    usage,
  };
}

// --- run the batch ---------------------------------------------------------------
const t0 = Date.now();
const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const winsBySlot = new Map();
const winsByFaction = new Map();
const winsByStart = new Map();
const reasons = new Map();
const usageTotal = new Map();
const lengths = [];
const firstCombats = [];
let draws = 0;
let errors = 0;
let decided = 0;
let snowballHits = 0;
let battlesTotal = 0;

for (let i = 0; i < N; i++) {
  const r = runMatch(i);
  if (r.error) {
    errors++;
    continue;
  }
  battlesTotal += r.battles;
  lengths.push(r.lengthMs);
  if (r.firstCombatAt !== null) firstCombats.push(r.firstCombatAt);
  if (r.winner === null) draws++;
  else {
    bump(winsBySlot, r.winner);
    bump(winsByFaction, r.winnerFaction ?? '?');
    bump(winsByStart, r.winnerStart ?? '?');
    bump(reasons, r.reason ?? '?');
    decided++;
    if (r.midLeader !== null && r.midLeader === r.winner) snowballHits++;
  }
  for (const [k, v] of r.usage) bump(usageTotal, k, v);
  if ((i + 1) % 10 === 0) process.stderr.write(`  … ${i + 1}/${N}\r`);
}

const days = (ms) => (ms / DAY).toFixed(1);
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`);
const fmtWins = (m) =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v} (${pct(v, decided)})`)
    .join(' · ') || '—';
const topUsage = [...usageTotal.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .map(([k, v]) => `${k}=${v}`)
  .join(' ');
const zeros = Object.keys({ ...data.units, ...data.buildings }).filter((k) => !usageTotal.has(k));

console.log(
  [
    `━━ self-play balance ━━ ${N} матчей · seed "${BASE_SEED}-*" · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    `  decided   : ${decided} · draws ${draws} (кап ${days(CAP)}д)${errors ? ` · ERRORS ${errors}` : ''}`,
    `  win by slot    : ${fmtWins(winsBySlot)}   ← цель ~50/50`,
    `  win by faction : ${fmtWins(winsByFaction)}`,
    `  win by start   : ${fmtWins(winsByStart)}`,
    `  длина      : avg ${days(avg(lengths))}д · min ${days(Math.min(...lengths))}д · max ${days(Math.max(...lengths))}д · исходы: ${fmtWins(reasons)}`,
    `  1-й бой    : avg ${days(avg(firstCombats))}д (в ${firstCombats.length}/${N} матчах) · боёв всего ${battlesTotal}`,
    `  snowball   : ${pct(snowballHits, decided)} лидеров середины выиграли  ← высокий % = снежный ком, камбэков нет`,
    `  usage      : ${topUsage || '—'}`,
    zeros.length ? `  мёртвый контент (0 построек за ${N} матчей): ${zeros.join(' ')}` : '  мёртвый контент: нет ✓',
    '━'.repeat(70),
    'SELFPLAY_JSON ' +
      JSON.stringify({
        n: N,
        decided,
        draws,
        errors,
        winsBySlot: Object.fromEntries(winsBySlot),
        winsByFaction: Object.fromEntries(winsByFaction),
        winsByStart: Object.fromEntries(winsByStart),
        avgLengthDays: avg(lengths) / DAY,
        snowball: decided ? snowballHits / decided : null,
      }),
  ].join('\n'),
);
