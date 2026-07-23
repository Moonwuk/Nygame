// ECON playtest harness — AI-vs-AI on the REAL kernel, headless, seeded, and it
// captures the ECON-6 hourly economy snapshot each game-hour (the same
// `economySnapshot` the live netserver emits into its JSONL). Answers the Bytro
// question with data: does a resource pile up, and where does it go?
//
//   node prototype/econplaytest.mjs            # 4-seat FFA, 40 game-days, seeds sp-0..2
//   node prototype/econplaytest.mjs 60 6 5     # 60 days, 6 seats, 5 seeds
//
// Mirrors selfplay.mjs's proven driver loop (advance → each seat's AI orders every
// ~2 game-hours); adds the per-hour economy capture + a faucet/sink read.
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';

const DAYS = Math.max(5, Number(process.argv[2] ?? 40) || 40);
const SEATS_N = Math.max(2, Math.min(10, Number(process.argv[3] ?? 4) || 4));
const SEEDS = Math.max(1, Number(process.argv[4] ?? 3) || 3);
const POSTURE = process.argv[5] ?? 'expand'; // 'expand' (war) | 'defend' (peaceful builders)

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
const {
  newGame,
  kernel,
  data,
  aiOrders,
  economySnapshot,
  HOUR,
  DAY,
  SCORE_LIMIT,
  START_CANDIDATES,
} = mod.exports;

const STEP = 2 * HOUR; // AI decision cadence (mirrors the netserver driver)
const HOUSES = [
  ['blue', 'Azure'],
  ['red', 'Crimson'],
  ['amber', 'Amber'],
  ['violet', 'Violet'],
];
const RES = ['metal', 'credits', 'food', 'energy', 'microelectronics'];
// Study steady-state economy, not the score race: push the score win out of reach
// and end strictly on the time horizon, so credits/metal curves run the full length.
const config = { timeScale: 1, victory: { scoreLimit: 100_000_000, endsAt: DAYS * DAY } };
const ctx = (now) => ({ now, data, config });

function seats(n) {
  return Array.from({ length: n }, (_, i) => {
    const [faction, name] = HOUSES[i % HOUSES.length];
    return { id: `p${i + 1}`, name: `${name} ${i + 1}`, faction, start: START_CANDIDATES[i], ai: true };
  });
}

// Cost of a build event, resolving building level / unit count against `data`.
function buildingCost(building, level = 1) {
  const def = data.buildings[building];
  if (!def) return {};
  if (level <= 1) return def.cost ?? {};
  return def.upgrades?.[level - 2]?.cost ?? def.cost ?? {};
}

function runMatch(seed, n) {
  let state = newGame({ seats: seats(n), seed });
  const ids = Object.keys(state.players);

  // Per-player hourly stock series + arrears-hours + spend/faucet ledger.
  const series = Object.fromEntries(ids.map((id) => [id, []])); // [{d, res...}]
  const arrearsHours = Object.fromEntries(ids.map((id) => [id, 0]));
  const spend = Object.fromEntries(ids.map((id) => [id, { building: {}, unit: {}, marketPaid: 0 }]));
  const built = Object.fromEntries(ids.map((id) => [id, {}])); // building/unit -> count
  let battles = 0;

  const consume = (events) => {
    for (const e of events) {
      const p = e.payload ?? {};
      if (e.type === 'building.constructed' || e.type === 'building.upgraded') {
        const owner = p.owner ?? ownerOfPlanet(state, p.planetId);
        if (owner && spend[owner]) {
          const cost = buildingCost(p.building, p.level ?? 1);
          for (const [r, v] of Object.entries(cost))
            spend[owner].building[r] = (spend[owner].building[r] ?? 0) + v;
          built[owner][p.building] = (built[owner][p.building] ?? 0) + 1;
        }
      } else if (e.type === 'unit.built') {
        const owner = p.owner ?? ownerOfPlanet(state, p.planetId);
        if (owner && spend[owner]) {
          const cost = data.units[p.unit]?.cost ?? {};
          const cnt = p.count ?? 1;
          for (const [r, v] of Object.entries(cost))
            spend[owner].unit[r] = (spend[owner].unit[r] ?? 0) + v * cnt;
          built[owner][p.unit] = (built[owner][p.unit] ?? 0) + cnt;
        }
      } else if (e.type === 'market.traded') {
        // Buyer (taker of a sell lot) pays credits; record the gross spend.
        if (spend[p.taker]) spend[p.taker].marketPaid += (p.amount ?? 0) * (p.price ?? 0);
      } else if (e.type === 'battle.resolved') battles++;
    }
  };

  let now = 0;
  let lastEconAt = -HOUR;
  const cap = (DAYS + 20) * DAY;
  while (now < cap && state.match.status !== 'ended') {
    now += STEP;
    for (let c = 0; c < 10; c++) {
      const r = kernel.advanceTo(state, ctx(now));
      if (!r.ok) return { error: r.code, seed };
      const prev = state.time;
      state = r.state;
      consume(r.events);
      if (!r.partial) break;
      if (r.state.time <= prev && c > 0) break;
    }
    // Hourly economy capture (downsample the snapshot to whole game-hours).
    while (now - lastEconAt >= HOUR) {
      lastEconAt += HOUR;
      const snap = economySnapshot(state);
      const d = lastEconAt / DAY;
      for (const id of ids) {
        const row = snap.players[id];
        if (!row) continue;
        series[id].push({ d, ...Object.fromEntries(RES.map((r) => [r, row.resources[r] ?? 0])) });
        if ((row.arrears ?? []).length > 0) arrearsHours[id] += 1;
      }
    }
    if (state.match.status === 'ended') break;
    for (const seat of ids) {
      for (const a of aiOrders(state, seat, POSTURE)) {
        const r = kernel.applyAction(state, a, ctx(now));
        if (r.ok) {
          state = r.state;
          consume(r.events);
        }
      }
    }
  }

  return {
    seed,
    lengthDays: state.time / DAY,
    ended: state.match.status === 'ended',
    winner: state.match.winner ?? null,
    reason: state.match.reason,
    battles,
    ids,
    series,
    arrearsHours,
    spend,
    built,
    finalPlanets: Object.fromEntries(
      ids.map((id) => [id, Object.values(state.planets).filter((pp) => pp.owner === id).length]),
    ),
  };
}

function ownerOfPlanet(state, planetId) {
  return planetId ? (state.planets[planetId]?.owner ?? null) : null;
}

// --- run ---------------------------------------------------------------------
const t0 = Date.now();
const runs = [];
for (let s = 0; s < SEEDS; s++) {
  const r = runMatch(`sp-${s}`, SEATS_N);
  if (r.error) {
    console.error(`seed sp-${s}: ERROR ${r.error}`);
    continue;
  }
  runs.push(r);
  process.stderr.write(`  … seed ${s + 1}/${SEEDS} (${r.lengthDays.toFixed(1)}d)\r`);
}

// Aggregate faucet/sink + pile-up read across all players of all runs.
const agg = {
  finalStock: Object.fromEntries(RES.map((r) => [r, []])),
  peakStock: Object.fromEntries(RES.map((r) => [r, []])),
  buildSpend: Object.fromEntries(RES.map((r) => [r, 0])),
  unitSpend: Object.fromEntries(RES.map((r) => [r, 0])),
  marketPaid: 0,
  arrearsHours: Object.fromEntries(RES.map((r) => [r, 0])), // by which resource? we track any-arrears hours per player
  built: {},
  playerCount: 0,
  totalHours: 0,
};
const anyArrearsHours = [];
for (const run of runs) {
  for (const id of run.ids) {
    const ser = run.series[id];
    if (!ser.length) continue;
    agg.playerCount++;
    agg.totalHours += ser.length;
    anyArrearsHours.push(run.arrearsHours[id]);
    const last = ser[ser.length - 1];
    for (const r of RES) {
      agg.finalStock[r].push(last[r]);
      agg.peakStock[r].push(Math.max(...ser.map((x) => x[r])));
      agg.buildSpend[r] += run.spend[id].building[r] ?? 0;
      agg.unitSpend[r] += run.spend[id].unit[r] ?? 0;
    }
    agg.marketPaid += run.spend[id].marketPaid;
    for (const [b, c] of Object.entries(run.built[id])) agg.built[b] = (agg.built[b] ?? 0) + c;
  }
}
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const med = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

// Day-by-day median stock across all players (the pile-up curve).
const maxDay = Math.max(...runs.map((r) => Math.max(...r.ids.map((id) => r.series[id].at(-1)?.d ?? 0))));
const dayCurve = [];
for (let day = 1; day <= Math.min(DAYS, Math.floor(maxDay)); day++) {
  const perRes = Object.fromEntries(RES.map((r) => [r, []]));
  for (const run of runs) {
    for (const id of run.ids) {
      // nearest hourly sample at/just-before `day`
      const ser = run.series[id];
      let pick = null;
      for (const x of ser) {
        if (x.d <= day) pick = x;
        else break;
      }
      if (pick) for (const r of RES) perRes[r].push(pick[r]);
    }
  }
  dayCurve.push({ day, ...Object.fromEntries(RES.map((r) => [r, Math.round(med(perRes[r]))])) });
}

// --- report ------------------------------------------------------------------
const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);
const lines = [];
lines.push(
  `━━ ECON playtest ━━ ${runs.length} матчей · ${SEATS_N} сторон · поза «${POSTURE}» · ${DAYS}д цель · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
lines.push(
  `  длина: avg ${mean(runs.map((r) => r.lengthDays)).toFixed(1)}д · боёв ${runs.reduce((s, r) => s + r.battles, 0)} · закончились ${runs.filter((r) => r.ended).length}/${runs.length}`,
);
lines.push(`  игроко-часов замерено: ${agg.totalHours} · игроков ${agg.playerCount}`);
lines.push('');
lines.push('  ЗАПАС на конец матча (median / mean / peak по игрокам):');
for (const r of RES) {
  lines.push(
    `    ${r.padEnd(17)} med ${fmt(med(agg.finalStock[r])).padStart(6)} · mean ${fmt(mean(agg.finalStock[r])).padStart(6)} · peak ${fmt(med(agg.peakStock[r])).padStart(6)}`,
  );
}
lines.push('');
lines.push('  СТОКИ (суммарно по всем игрокам/матчам, потрачено на):');
for (const r of RES) {
  const b = agg.buildSpend[r];
  const u = agg.unitSpend[r];
  if (b + u === 0) continue;
  lines.push(`    ${r.padEnd(17)} постройки ${fmt(b).padStart(7)} · юниты ${fmt(u).padStart(7)}`);
}
lines.push(`    market (куплено за credits): ${fmt(agg.marketPaid)}`);
lines.push('');
lines.push(`  arrears-часы на игрока: med ${med(anyArrearsHours)} · max ${Math.max(...anyArrearsHours, 0)} (из ~${Math.round(agg.totalHours / Math.max(1, agg.playerCount))}ч)`);
lines.push('');
lines.push('  ПОСТРОЕНО (все игроки/матчи):');
lines.push(
  '    ' +
    Object.entries(agg.built)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(' '),
);
lines.push('');
lines.push(`  КРИВАЯ ЗАПАСА (median по игрокам, по дням) — «пилит вверх» = копится:`);
lines.push('    день │ ' + RES.map((r) => r.slice(0, 6).padStart(7)).join(' │ '));
const sampleDays = dayCurve.filter((_, i) => i % Math.max(1, Math.ceil(dayCurve.length / 15)) === 0 || i === dayCurve.length - 1);
for (const row of sampleDays) {
  lines.push('    ' + String(row.day).padStart(4) + ' │ ' + RES.map((r) => fmt(row[r]).padStart(7)).join(' │ '));
}
lines.push('━'.repeat(72));

const out = lines.join('\n');
console.log(out);

writeFileSync(
  'prototype/econ-playtest-result.json',
  JSON.stringify(
    {
      days: DAYS,
      seats: SEATS_N,
      seeds: runs.length,
      finalStock: Object.fromEntries(RES.map((r) => [r, { med: med(agg.finalStock[r]), mean: mean(agg.finalStock[r]) }])),
      peakStock: Object.fromEntries(RES.map((r) => [r, med(agg.peakStock[r])])),
      buildSpend: agg.buildSpend,
      unitSpend: agg.unitSpend,
      marketPaid: agg.marketPaid,
      arrearsHoursMedian: med(anyArrearsHours),
      built: agg.built,
      dayCurve,
    },
    null,
    2,
  ),
);
