// Serves the prototype's OWN world over WebSocket so two browsers — or two phones
// running the APK — can play the same session against one authoritative core.
//
//   pnpm dev:proto-server                          # 127.0.0.1:8788
//   HOST=0.0.0.0 PORT=8788 pnpm dev:proto-server   # reachable on the LAN
//   (then expose it with a tunnel — see docs/multiplayer.md — for a remote friend)
//
// Throwaway dev harness, like the prototype itself: built by esbuild
// (netserver.mjs), ESLint-ignored, and never typechecked. It reuses the
// prototype's exact `kernel` + `data` + `newGame()`, so the world the server
// hosts is byte-identical to the one the client already knows how to draw — the
// client's `MAP` lines up 1:1 with the server's planets and the renderer needs
// no changes. This is NOT the Stage-3 server: state lives in memory (a restart
// loses the match) and the `?player=` handshake is unauthenticated.
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import pgPkg from 'pg';
import {
  MatchRoom,
  MatchRegistry,
  createMultiplayerServer,
  registerBrowserApi,
  MemoryAccountStore,
  MemoryMatchStore,
  MemoryReceiptStore,
  PostgresAccountStore,
  PostgresMatchStore,
  PostgresReceiptStore,
  migrate,
  type AccountStore,
  type MatchStore,
  type ReceiptStore,
  type RoomObservation,
} from '../packages/server/src/index';
import {
  newGame,
  kernel,
  data,
  DEFAULT_SETUP,
  SCORE_LIMIT,
  aiOrders,
  stewardActive,
  HOUR,
  serverQueueActions,
  serverAutoAssaultActions,
  serverPatrolActions,
  orderPop,
  orderHold,
  orderBlock,
  orderScramble,
  patrolStamp,
} from './src/game';
const { Pool } = pgPkg;

// --- M0 playtest log: append every room event (join/leave/lobby/action/end) to a
// per-run JSONL, and keep counters for an on-exit summary. Pure observation.
mkdirSync('playtest-logs', { recursive: true });
const logFile = `playtest-logs/proto-${Date.now()}.jsonl`;
const stats = {
  joins: 0,
  leaves: 0,
  actions: 0,
  ok: 0,
  rejects: 0,
  byCode: {} as Record<string, number>,
  byType: {} as Record<string, number>,
  end: null as RoomObservation | null,
};
let connected = 0; // live players currently connected (drives the running-match heartbeat)
// Seats with a live human peer. Any seat in the match NOT in here is "empty" and is
// driven by the server-side AI (mirrors single-player: empty slots are taken by the AI).
const humans = new Set<string>();
const observe = (ev: RoomObservation): void => {
  appendFileSync(logFile, JSON.stringify({ t: Date.now(), ...ev }) + '\n');
  if (ev.kind === 'join') {
    stats.joins++;
    connected++;
    humans.add(ev.playerId);
  } else if (ev.kind === 'leave') {
    stats.leaves++;
    connected = Math.max(0, connected - 1);
    humans.delete(ev.playerId);
  } else if (ev.kind === 'end') stats.end = ev;
  else if (ev.kind === 'action') {
    stats.actions++;
    stats.byType[ev.type] = (stats.byType[ev.type] ?? 0) + 1;
    if (ev.ok) stats.ok++;
    else {
      stats.rejects++;
      if (ev.code) stats.byCode[ev.code] = (stats.byCode[ev.code] ?? 0) + 1;
    }
    // Persist the receipt so a retried action stays deduped across a restart.
    void receiptStore.save('proto', {
      actionId: ev.actionId,
      playerId: ev.playerId,
      seq: ev.seq,
      ok: ev.ok,
      ...(ev.code ? { code: ev.code } : {}),
    });
  }
  // Persist after anything that changes the world or the lobby (debounced below),
  // and re-arm the offline wakeup: an action may schedule or consume events, and a
  // lobby Start releases the frozen clock — both move the next-event time.
  if (ev.kind === 'action' || ev.kind === 'lobby' || ev.kind === 'end') scheduleSave();
  // Re-arm on room events: an action may (un)schedule events, a lobby Start releases
  // the clock, and a join/leave starts/stops the live-player heartbeat below. A genuine
  // external event also gives the stall guard a fresh chance (the situation may have
  // changed). `advance_overflow` is EXCLUDED: a stalled catch-up emits it from inside
  // `room.tick()` itself, so resetting/re-arming on it would defeat the wake-stall
  // back-off in `onWake` (an eternal 0ms wake spin).
  if (ev.kind !== 'advance_overflow') {
    wakeStalls = 0;
    armWakeup();
  }
};

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8788);
// Playtest fast-forward: wall→game clock multiplier. TIME_SCALE=100 ⇒ a real minute
// is ~1.7 game-hours, so fleets/builds/economy resolve on-screen instead of over real
// hours. 1 (default) = real-time. Compresses the clock itself, not just durations.
const TIME_SCALE = Math.max(1, Number(process.env.TIME_SCALE ?? 1) || 1);

// Serve the built prototype HTML at `/` so a peer just opens `http://host:port/`
// (no file transfer; the connect overlay auto-fills the same-origin ws:// URL).
const htmlPath = 'prototype/dist/void-dominion.html';
const indexHtml = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : undefined;

// Every non-internal IPv4 this host owns (the candidates other devices could dial).
function ipv4s(): string[] {
  const all: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) all.push(i.address);
    }
  }
  return all;
}

// Classify an IPv4 by how a peer can reach it (mirrors `pnpm doctor`). A VM-NAT
// (VirtualBox/QEMU) or link-local address prints fine but is a dead end off this
// box — the trap behind "works locally, friend can't join".
function ipKind(ip: string): 'vm-nat' | 'link-local' | 'cgnat' | 'lan' | 'public' {
  if (ip.startsWith('10.0.2.') || ip.startsWith('10.0.3.')) return 'vm-nat';
  if (ip.startsWith('169.254.')) return 'link-local';
  const [a, b] = ip.split('.').map(Number);
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (ip.startsWith('192.168.') || ip.startsWith('10.') || (a === 172 && b >= 16 && b <= 31)) {
    return 'lan';
  }
  return 'public';
}

// Durability: with DATABASE_URL set, the match is snapshotted to Postgres and
// survives a restart; otherwise it's in-memory (a restart loses it, as before).
const DATABASE_URL = process.env.DATABASE_URL;
let pool: InstanceType<typeof Pool> | null = null;
let matchStore: MatchStore;
let accountStore: AccountStore;
let receiptStore: ReceiptStore;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL });
  await migrate(pool);
  matchStore = new PostgresMatchStore(pool);
  accountStore = new PostgresAccountStore(pool);
  receiptStore = new PostgresReceiptStore(pool);
} else {
  matchStore = new MemoryMatchStore();
  accountStore = new MemoryAccountStore();
  receiptStore = new MemoryReceiptStore();
}
const restored = await matchStore.load('proto');
// NET seats are all HUMAN chairs (the server AI only stands in for an EMPTY one), so
// seed the world with every seat un-branded ai:false — newGame then deals each seat
// its research council and start kit symmetrically. Seeding the solo default here
// left a live player on p2 without scientists (the «Хранитель» line unreachable).
const initialState =
  restored?.state ??
  newGame({ seats: DEFAULT_SETUP.seats.map((seat) => ({ ...seat, ai: false })) });
// A NET seat is not a bot: every seat here is claimable by a human, and the
// server-side AI merely stands in for an empty chair (`humans` is the live truth).
// Strip the static `ai` branding newGame took from the seat config, or two humans
// on DEFAULT_SETUP seats could never ally (E_BOT_ALLIANCE against seat p2 forever).
for (const seat of Object.values(initialState.players)) delete seat.ai;
// Rehydrate idempotency receipts so a retried action stays deduped across a restart.
const initialReceipts = await receiptStore.loadAll('proto');

// Lobby gate: the world clock starts at 0 ("Day 1") and stays frozen until the host
// presses Start. On restore mid-match we skip the lobby and resume the running game.
const room = new MatchRoom({
  id: 'proto',
  initialState,
  kernel,
  data,
  now: () => Date.now(),
  manualStart: true, // lobby: clock frozen until the host (first in) presses Start
  initiallyStarted: !!restored, // restored snapshot → resume into the game, skip lobby
  singlePeerPerPlayer: true, // 1v1: each side is one connection — no two-people-as-Azure
  emitStateHash: true, // attach hashState(view) so the client overlay can flag desync
  observe, // M0: log every room event to JSONL + count for the on-exit summary
  initialReceipts, // rehydrated idempotency (deduped action stays deduped after restart)
  // The kernel context config must match what the local sim (and the HUD) promise:
  // without it victory falls back to its 600 default while the HUD counts to 450.
  config: { timeScale: 1, victory: { scoreLimit: SCORE_LIMIT } },
  initialSeq: restored?.seq, // resume the action counter — else the optimistic-by-seq
  // store drops post-restart saves until seq climbs back past the stored value
  // Strict commit-before-broadcast: await the durable write of the new snapshot +
  // receipt before the room commits state / broadcasts. The debounced scheduleSave in
  // `observe` above becomes a harmless coalesced extra for actions (still needed for
  // tick-driven advances, which are recomputable and persist after the fact).
  persist: async (snapshot, receipt) => {
    await matchStore.save(snapshot);
    await receiptStore.save('proto', receipt);
  },
  timeScale: TIME_SCALE, // playtest fast-forward (1 = real-time)
});

// Snapshot the world after changes, debounced so a burst of actions is one write.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void doSave();
  }, 500);
}
async function doSave(): Promise<void> {
  if (saving) {
    scheduleSave(); // a save is in flight — coalesce into the next tick
    return;
  }
  saving = true;
  try {
    await matchStore.save({
      matchId: 'proto',
      dataVersion: room.state.version?.data ?? 'proto',
      seq: room.sequence,
      status: room.state.match.status === 'ended' ? 'ended' : 'ongoing',
      state: room.state,
    });
  } catch (e) {
    process.stderr.write(`snapshot save failed: ${(e as Error)?.message ?? String(e)}\n`);
  }
  saving = false;
}

// Offline scheduler (PA-4.1): a single-process wakeup driver so the world runs
// 24/7 even with nobody connected. The in-state schedule is mirrored as ONE
// pending timer set to the soonest event; when it fires we `tick()` the room
// (advance + broadcast the arrivals/battles/captures that came due) and re-arm.
// `setTimeout` overflows past ~24.8 days, so a far-future event is capped to
// MAX_TIMER_MS and we re-arm — a long sleep taken in hops. Note: NO downtime
// catch-up — the room resumes its clock at the saved `state.time` (initiallyStarted),
// so the gap while the process was down is simply skipped, not replayed. The
// distributed/durable evolution is a job queue on Postgres (pg-boss): one shared
// "wake match X at T" job across many server processes instead of one in-memory
// timer per room — see docs/persistence-accounts-roadmap.md (PA-4).
const MAX_TIMER_MS = 60 * 60_000; // 1h cap (setTimeout overflow + clock-drift safety)
// While a STARTED match has connected players, tick at least this often even if the
// schedule is momentarily empty — otherwise the world only advances when someone issues
// an order (submitAction), so the published clock/economy/in-flight fleets freeze
// on-screen between actions. newGame() starts with NO scheduled events, so without this
// the very first thing players see after Start is a frozen "Day 1 00:00".
const HEARTBEAT_MS = 1_000;
const WAKE_STALL_LIMIT = 3; // consecutive due-but-non-progressing wakes → back off
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let wakeStalls = 0;
function armWakeup(): void {
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  const ev = room.msUntilNextEvent(); // wall-ms to the next scheduled event, or null
  const beat = room.isStarted && connected > 0 ? HEARTBEAT_MS : null; // live-player heartbeat
  if (ev === null && beat === null) return; // nothing scheduled and nobody live → idle
  const ms = ev === null ? beat : beat === null ? ev : Math.min(ev, beat);
  wakeTimer = setTimeout(onWake, Math.min(ms ?? MAX_TIMER_MS, MAX_TIMER_MS));
}
// Server-side AI for empty seats: every ~2 game-hours, any match seat with no live
// human peer issues the same orders the single-player AI would (shared `aiOrders`),
// submitted through the authoritative room. Runs only while the match is started and
// someone is connected — otherwise the board just idles on its schedule. This is what
// makes "empty multiplayer slots are taken by the AI" true: an unjoined seat plays.
let aiLastAt = 0; // game-time of the last AI decision tick
function runServerAI(): void {
  if (!room.isStarted || connected === 0) return;
  const now = room.state.time;
  if (now - aiLastAt < 2 * HOUR) return;
  aiLastAt = now;
  for (const seat of Object.keys(room.state.players)) {
    // «Хранитель»: a delegated seat is played by the AI on its posture (defend) even while
    // its owner is connected but asleep; an unclaimed/empty seat gets the full expansion AI.
    const posture = stewardActive(room.state, seat, now);
    if (humans.has(seat) && !posture) continue; // a human is actively commanding this seat
    for (const action of aiOrders(room.state, seat, posture ?? 'expand')) {
      room.submitAction(seat, action);
    }
  }
}

// CC-server: drive the authoritative per-fleet command-chains server-side, so a queued
// chain (move → assault → load → wait → …) advances even with NOBODY connected — the
// player "sleeps and it plays". The pure decision is `serverQueueActions` (tested); this
// just issues its orders + pop/hold through the same authoritative room, mirroring
// runServerAI. Runs on every wake (heartbeat while connected, event wakeup while offline).
function runServerQueues(): void {
  if (!room.isStarted) return;
  const now = room.state.time;
  for (const step of serverQueueActions(room.state, now)) {
    // A rejected step BLOCKS the chain with its reason (order.block) instead of being
    // silently popped — the owner wakes up to «⚠ шаг: причина», not a derailed plan
    // that kept executing in the wrong place (CC-4.1 minimum).
    let failed = step.fail ?? null;
    if (!failed) {
      for (const a of step.actions) {
        const r = room.submitAction(step.owner, a);
        if (!r.ok) {
          failed = r.code ?? 'E_INTERNAL';
          break;
        }
      }
    }
    if (failed) {
      room.submitAction(step.owner, orderBlock(step.owner, step.fleetId, failed));
      continue;
    }
    if (step.holdUntil !== undefined) room.submitAction(step.owner, orderHold(step.owner, step.fleetId, step.holdUntil));
    if (step.pop) room.submitAction(step.owner, orderPop(step.owner, step.fleetId));
  }
}

// CC-2 / CC-4: drive the authoritative STANDING orders (auto-storm + дежурный вылет)
// server-side, same shape as runServerQueues — the pure decisions live in game.ts
// (serverAutoAssaultActions / serverPatrolActions, tested); this just applies them
// through the authoritative room. A rejected storm is simply skipped (a standing
// stance has no chain to block); patrol runtime state persists via patrol.stamp.
function runServerStanding(): void {
  if (!room.isStarted) return;
  for (const a of serverAutoAssaultActions(room.state)) {
    for (const act of a.actions) if (!room.submitAction(a.owner, act).ok) break;
  }
  for (const p of serverPatrolActions(room.state, room.state.time)) {
    if (p.drop) {
      if (p.owner) room.submitAction(p.owner, orderScramble(p.owner, p.fleetId, false));
      continue;
    }
    if (p.patch) room.submitAction(p.owner, patrolStamp(p.owner, p.fleetId, p.patch.sortie, p.patch.rearmAt));
    for (const act of p.actions) room.submitAction(p.owner, act);
  }
}

function onWake(): void {
  wakeTimer = null;
  const progressed = room.tick(); // fire whatever is now due (no-op if a capped timer fired early)
  // Stall guard: work is due (ms 0) but the clock didn't move ⇒ a same-instant runaway.
  // While stalled, SKIP the AI/queue drivers — their submissions (even rejected ones)
  // emit `action` observations that would reset this guard and re-arm a 0ms wake — and
  // back off after a few tries instead of busy-looping (the room has already surfaced
  // an advance_overflow). A real player action re-arms via `observe`, which resets the
  // counter and gives it a fresh chance.
  const stalled = !progressed && room.msUntilNextEvent() === 0;
  if (!stalled) {
    wakeStalls = 0;
    runServerAI(); // drive any empty seat once the clock has moved
    runServerQueues(); // CC-server: advance each fleet's authoritative order chain
    runServerStanding(); // CC-2/CC-4: standing orders (auto-storm / дежурный вылет)
  }
  scheduleSave(); // persist the advanced world
  if (stalled && ++wakeStalls >= WAKE_STALL_LIMIT) {
    process.stderr.write(
      'wakeup driver idling: the world clock stalled (a same-instant scheduling loop) — ' +
        'check for a module scheduling events at its own instant.\n',
    );
    return; // idle — do not re-arm
  }
  armWakeup(); // re-arm for the next event (or the remainder of a long sleep)
}

// One match for now, exposed through the registry so the client's match browser
// (GET /matches) lists it with its real status (map / rules / day / players).
const registry = new MatchRegistry(accountStore);
registry.register(room, {
  mapId: 'nexus',
  rules: { timeScale: TIME_SCALE },
  createdAt: Date.now(),
  startedAt: initialState.time,
});
const server = createMultiplayerServer({
  registry,
  host,
  port,
  indexHtml,
  accountStore, // `?nick=` WS login resolves its seat here
  // The match-browser read-model + archive intents (GET /matches, POST …/archive).
  httpRoutes: (app) => registerBrowserApi(app, registry),
});
let wsUrl: string;
try {
  wsUrl = await server.listen();
} catch (err) {
  // The port never opened — say why (in plain language) instead of dumping an
  // unhandled-rejection stack, which reads as "the server doesn't start".
  const code = (err as { code?: string }).code;
  process.stderr.write(
    code === 'EADDRINUSE'
      ? `\nPort ${port} is already in use — another server is still running, or a stale one didn't exit.\n` +
          `  Free it, or start on another port:  PORT=${port + 1} pnpm host\n\n`
      : `\nFailed to start the server: ${(err as Error)?.message ?? String(err)}\n\n`,
  );
  process.exit(1);
}
const httpUrl = wsUrl.replace(/^ws/, 'http').replace(/\/matches\/.*$/, '');

// Pick the address a friend actually dials: a real LAN/public IPv4, never a
// VM-NAT/link-local one. `pnpm doctor` prints the full reachability breakdown.
const addrs = host === '0.0.0.0' ? ipv4s() : [];
const shareIp =
  addrs.find((a) => ipKind(a) === 'public') ?? addrs.find((a) => ipKind(a) === 'lan') ?? null;
const onLan = shareIp !== null;
const unreachableOnly = host === '0.0.0.0' && !onLan && addrs.length > 0;
const localHttp = httpUrl.replace('0.0.0.0', 'localhost'); // 0.0.0.0 isn't openable
const friendUrl = onLan ? `http://${shareIp}:${port}/` : null;

const lines = [
  'Void Dominion — prototype dev server (real core)',
  indexHtml
    ? `  game   : ${localHttp}/   (open in a browser → Connect)`
    : `  game   : run \`pnpm prototype\` first to serve the HTML at /`,
  `  health : ${localHttp}/health`,
  DATABASE_URL
    ? `  store  : Postgres — durable${restored ? ' (resumed a saved match)' : ''}`
    : '  store  : in-memory — a restart loses the match (set DATABASE_URL for durability)',
  TIME_SCALE > 1
    ? `  time   : ×${TIME_SCALE} fast-forward (1 real min ≈ ${(TIME_SCALE / 60).toFixed(1)} game-hours) — playtest mode`
    : '  time   : ×1 real-time (set TIME_SCALE=100 to fast-forward a playtest)',
  '',
  '  Two-person test:',
  `   • You:    open ${localHttp}/  → Connect → Azure (p1)`,
  onLan
    ? `   • Friend: open ${friendUrl}  (same Wi-Fi) → Connect → Crimson (p2)`
    : '   • Friend: run `pnpm host` (binds 0.0.0.0 → prints a LAN URL), or tunnel the port for a remote friend — see docs/multiplayer.md',
];
if (unreachableOnly) {
  lines.push(
    `   ⚠ only a non-routable address (${addrs.join(', ')}) — VM-NAT/link-local, unreachable off this box.`,
    `     Remote friend? Tunnel it:  cloudflared tunnel --url http://localhost:${port}   (or run \`pnpm doctor\`)`,
  );
}
lines.push('', `  raw ws : ${wsUrl.replace('0.0.0.0', 'localhost')}?player=p1  ·  …?player=p2`, '');
process.stdout.write(lines.join('\n'));

// Start the offline heartbeat: if a restored match already has a due/pending event,
// this arms the first wake (no burst — the clock resumes at the saved time).
armWakeup();

// On Ctrl-C: print the playtest summary (counts gathered by `observe`) and where
// the raw JSONL landed, then close cleanly — the per-match data survives the run.
const printSummary = (): void => {
  const end = stats.end;
  const fmt = (m: Record<string, number>): string =>
    Object.entries(m)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ') || '—';
  process.stdout.write(
    [
      '',
      '── playtest summary ──────────────────────────────',
      `  joins ${stats.joins} · leaves ${stats.leaves} · actions ${stats.actions} (ok ${stats.ok} · rejects ${stats.rejects})`,
      `  by type   : ${fmt(stats.byType)}`,
      `  by reject : ${fmt(stats.byCode)}`,
      end && end.kind === 'end'
        ? `  match end : winner ${end.winner ?? '—'}${end.reason ? ` (${end.reason})` : ''}`
        : '  match end : —',
      `  log file  : ${logFile}`,
      '──────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
};

const shutdown = (): void => {
  printSummary();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  void (async () => {
    await doSave(); // final flush so the latest state is durable before we exit
    if (pool) await pool.end();
    await server.close();
    process.exit(0);
  })();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
