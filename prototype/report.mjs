// M3 match report (docs/metrics-roadmap.md): turn one playtest JSONL (written by
// netserver's observe stream) into a readable report — wall length, action mix,
// rejects, control-over-time (captures), desyncs, latencies. One match → one
// report, one command:
//
//   pnpm run metrics                     # newest playtest-logs/*.jsonl
//   pnpm run metrics playtest-logs/proto-123.jsonl
//
// Reads only; safe on a live log. Latency/delta aggregates come from the final
// `summary` line netserver appends on shutdown — before that (or after a crash)
// the report falls back to the anomalous-only per-line entries with a caveat.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function newestLog() {
  const dir = 'playtest-logs';
  let best = null;
  let bestM = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const m = statSync(join(dir, f)).mtimeMs;
    if (m > bestM) {
      bestM = m;
      best = join(dir, f);
    }
  }
  if (!best) throw new Error('no .jsonl in playtest-logs/ — run a playtest first');
  return best;
}

const file = process.argv[2] ?? newestLog();
const lines = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      console.error(`  (skipping malformed line ${i + 1})`);
      return null;
    }
  })
  .filter(Boolean);

if (lines.length === 0) {
  console.error(`empty log: ${file}`);
  process.exit(1);
}

// --- aggregate ----------------------------------------------------------------
const t0 = lines[0].t;
const tEnd = lines.at(-1).t;
const joins = new Map(); // player -> count
const leaves = new Map();
const actions = { total: 0, ok: 0, rejected: 0 };
const byType = new Map();
const byPlayer = new Map();
const rejectByCode = new Map();
const eventsByType = new Map();
const captures = []; // {t, planetId, owner, from}
const desyncs = [];
const perf = []; // client_perf samples
const timingsSeen = { submit: [], advance: [] }; // anomalous-only unless summary present
let lobbyStartT = null;
let end = null;
let summary = null;

const bump = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);

for (const ev of lines) {
  switch (ev.kind) {
    case 'join':
      bump(joins, ev.playerId);
      break;
    case 'leave':
      bump(leaves, ev.playerId);
      break;
    case 'lobby':
      if (ev.waiting === false && lobbyStartT === null) lobbyStartT = ev.t;
      break;
    case 'action':
      actions.total++;
      bump(byType, ev.type);
      bump(byPlayer, ev.playerId);
      if (ev.ok) actions.ok++;
      else {
        actions.rejected++;
        bump(rejectByCode, ev.code ?? 'E_INTERNAL');
      }
      break;
    case 'events':
      for (const e of ev.events ?? []) {
        bump(eventsByType, e.type);
        if (e.type === 'planet.captured') {
          const p = e.payload ?? {};
          captures.push({ t: ev.t, planetId: p.planetId, owner: p.owner, from: p.from });
        }
      }
      break;
    case 'desync':
      desyncs.push(ev);
      break;
    case 'client_perf':
      perf.push(ev);
      break;
    case 'timing':
      (timingsSeen[ev.op] ?? []).push(ev.ms);
      break;
    case 'end':
      end = ev;
      break;
    case 'summary':
      summary = ev.summary; // the aggregated truth, appended on shutdown
      break;
  }
}

// --- format --------------------------------------------------------------------
const mmss = (ms) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const top = (map, n = 8) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ') || '—';
const msStat = (x) =>
  !x || x.count === 0 ? '—' : `avg ${x.avg.toFixed(1)}ms · max ${x.max.toFixed(1)}ms (${x.count})`;

const out = [];
out.push(`━━ match report ━━ ${file}`);
out.push(`  span      : ${new Date(t0).toISOString()} → ${new Date(tEnd).toISOString()} (${mmss(tEnd - t0)})`);
if (lobbyStartT !== null) out.push(`  lobby     : старт через ${mmss(lobbyStartT - t0)} после первого события`);
out.push(`  players   : joins ${top(joins)} · leaves ${top(leaves)}`);
out.push('');
out.push(`  actions   : ${actions.total} (ok ${actions.ok} · rejects ${actions.rejected})`);
out.push(`    by type   : ${top(byType)}`);
out.push(`    by player : ${top(byPlayer)}`);
out.push(`    rejects   : ${top(rejectByCode)}`);
out.push('');
out.push(`  events    : ${top(eventsByType, 10)}`);
out.push(`  battles   : ${eventsByType.get('battle.resolved') ?? 0} · captures ${captures.length}`);
if (captures.length > 0) {
  out.push('  control over time (планета → новый владелец):');
  for (const c of captures.slice(0, 40)) {
    out.push(`    +${mmss(c.t - t0)}  ${c.planetId ?? '?'} → ${c.owner ?? '?'}${c.from ? ` (был ${c.from})` : ''}`);
  }
  if (captures.length > 40) out.push(`    … и ещё ${captures.length - 40}`);
}
out.push('');
out.push(`  desyncs   : ${desyncs.length}${desyncs.length ? '  ← ЦЕЛЬ 0, смотреть немедленно' : ' ✓'}`);
if (perf.length > 0) {
  const fps = perf.map((p) => p.fps);
  const rtt = perf.filter((p) => p.rttMs !== undefined).map((p) => p.rttMs);
  out.push(
    `  client    : ${perf.length} сэмплов · fps avg ${(fps.reduce((a, b) => a + b, 0) / fps.length).toFixed(0)} · min ${Math.min(...fps)}` +
      (rtt.length ? ` · rtt avg ${(rtt.reduce((a, b) => a + b, 0) / rtt.length).toFixed(0)}ms · max ${Math.max(...rtt)}ms` : ''),
  );
}
if (summary) {
  out.push(`  submit    : ${msStat(summary.submitMs)}`);
  out.push(`  advance   : ${msStat(summary.advanceMs)}`);
  out.push(
    `  broadcast : ${msStat(summary.broadcastMs)} · delta avg ${(summary.deltaBytes.avg / 1024).toFixed(2)}KB · max ${(summary.deltaBytes.max / 1024).toFixed(2)}KB`,
  );
} else {
  const slow = timingsSeen.submit.length + timingsSeen.advance.length;
  out.push(
    `  latencies : сводной строки нет (сервер ещё жив или упал) — в логе только аномалии: ${slow} медленных таймингов`,
  );
}
out.push(
  end
    ? `  match end : winner ${end.winner ?? '—'}${end.reason ? ` (${end.reason})` : ''}`
    : '  match end : не завершён',
);
out.push('━'.repeat(60));
console.log(out.join('\n'));
