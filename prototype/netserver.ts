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
  MetricsAggregator,
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
  networkSeats,
  parseNetworkMatchMode,
  SCORE_LIMIT,
  aiOrders,
  stewardActive,
  HOUR,
  serverAutoAssaultActions,
  serverPatrolActions,
  orderScramble,
  patrolStamp,
} from './src/game';
import { ActionGate } from '../packages/action-layer/src/index';
import { isValidActionPayload } from '../packages/shared-core/src/actions/payloadSchemas';
const { Pool } = pgPkg;

// --- M0/M1 playtest log: append room events to a per-run JSONL and feed every one
// to the MetricsAggregator for the on-exit summary. Pure observation. The M1
// high-frequency kinds are handled with care: `broadcast`/`timing` lines land in
// the JSONL only when anomalous (slow or fat) — the aggregator still counts them
// all — and `events` lines only fire on real activity (battles, arrivals).
mkdirSync('playtest-logs', { recursive: true });
const logFile = `playtest-logs/proto-${Date.now()}.jsonl`;
const metrics = new MetricsAggregator();
const SLOW_MS = 50; // a submit/broadcast slower than this is worth a JSONL line
const FAT_DELTA_BYTES = 10_240; // a per-player delta fatter than this too (target: idle < 1 KB)
function worthLogging(ev: RoomObservation): boolean {
  if (ev.kind === 'timing') return ev.ms >= SLOW_MS;
  if (ev.kind === 'broadcast') {
    return ev.ms >= SLOW_MS || Object.values(ev.deltaBytes).some((b) => b >= FAT_DELTA_BYTES);
  }
  return true;
}
// BF-17: the AI stand-in must not seize a seat the MOMENT it looks empty. `humans`
// is in-memory — after a server restart it is empty for everyone, and a mobile
// network blip drops a live player for seconds — so every "empty" seat gets a grace
// window (per-seat wall-clock deadline) before the expand-AI starts commanding it.
// Steward delegation bypasses the grace: handing the seat over was the player's call.
const AI_GRACE_MS = Number(process.env.AI_GRACE_MS ?? 10 * 60 * 1000);

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8788);
// Playtest fast-forward: wall→game clock multiplier. TIME_SCALE=100 ⇒ a real minute
// is ~1.7 game-hours, so fleets/builds/economy resolve on-screen instead of over real
// hours. 1 (default) = real-time. Compresses the clock itself, not just durations.
// GATE=1|true → only validated `action.v1` envelopes are accepted (bare `action`
// messages are rejected); the bundled client self-configures from `welcome.gated`.
// Mirrors packages/server serverConfig (per-room gate instance, shared validator).
const GATE = process.env.GATE === '1' || process.env.GATE === 'true';
// SEAT_LOCK=1|true → seat tickets (REL-5): a nick's first join mints a secret the
// client stores and must present on every reconnect (`?ticket=`), so knowing a URL
// or a nick is no longer enough to take someone's seat; `?player=` is refused.
const SEAT_LOCK = process.env.SEAT_LOCK === '1' || process.env.SEAT_LOCK === 'true';
const TIME_SCALE = Math.max(1, Number(process.env.TIME_SCALE ?? 1) || 1);

// Serve the built prototype HTML so a peer just opens `http://host:port/` (no file
// transfer; the connect overlay auto-fills the same-origin ws:// URL). Regular players
// get the PLAYER client at `/` (no test mode / single-player / time controls — see
// build.mjs); the full dev client stays one step away at `/dev` for the host. If the
// player artifact hasn't been built yet (stale dist), `/` falls back to the dev client.
const devHtmlPath = 'prototype/dist/void-dominion.html';
const playerHtmlPath = 'prototype/dist/void-dominion-player.html';
const devHtml = existsSync(devHtmlPath) ? readFileSync(devHtmlPath, 'utf8') : undefined;
const playerHtml = existsSync(playerHtmlPath) ? readFileSync(playerHtmlPath, 'utf8') : undefined;
const indexHtml = playerHtml ?? devHtml;

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
// The prototype host defaults to a ten-chair FFA. `TEAMS=5v5` keeps all ten chairs and
// seeds two allied flanks; `TEAMS=2v2` preserves the smaller four-chair playtest. Every
// chair is claimable by a human, while the server AI stands in after the reconnect grace.
const NETWORK_MODE = parseNetworkMatchMode(process.env.TEAMS);
const NET_SEATS = networkSeats(NETWORK_MODE);
// MATCHES=N hosts N independent sessions in THIS one process (default 1) — same mode
// and time scale for all; the match browser lists every one, players pick a row. Ids:
// `proto`, `proto-2`, … `proto-N` (the first keeps its historic id so an existing
// durable snapshot / saved seat tickets keep working across the upgrade).
const MATCHES = Math.max(1, Math.min(16, Number(process.env.MATCHES ?? 1) || 1));
const matchIds = Array.from({ length: MATCHES }, (_, i) => (i === 0 ? 'proto' : `proto-${i + 1}`));

// Shared wakeup-driver tuning (one instance of these per hosted match below).
const MAX_TIMER_MS = 60 * 60_000; // 1h cap (setTimeout overflow + clock-drift safety)
// While a match has connected players, tick at least this often even if the
// schedule is momentarily empty — otherwise the world only advances when someone issues
// an order (submitAction), so the published clock/economy/in-flight fleets freeze
// on-screen between actions. newGame() starts with NO scheduled events, so without this
// the very first thing players see after joining is a frozen "Day 1 00:00".
const HEARTBEAT_MS = 1_000;
const WAKE_STALL_LIMIT = 3; // consecutive due-but-non-progressing wakes → back off

/** One hosted session: a MatchRoom plus ALL its per-match machinery — the empty-seat
 *  AI (with the BF-17 reconnect grace), the standing-order drivers, the debounced
 *  durable snapshot and the offline wakeup timer. Everything that used to be a
 *  module-level single-match global lives in this closure now, one set per match. */
interface HostedMatch {
  id: string;
  room: MatchRoom;
  restored: boolean;
  armWakeup(): void;
  /** Final durable flush (shutdown). */
  flush(): Promise<void>;
  clearTimers(): void;
}

async function createHostedMatch(id: string): Promise<HostedMatch> {
  let connected = 0; // live players in THIS match (drives its running-match heartbeat)
  // Seats with a live human peer. Any seat NOT in here is "empty" and is driven by
  // the server-side AI (mirrors single-player: empty slots are taken by the AI).
  const humans = new Set<string>();
  const aiEligibleAt = new Map<string, number>();

  const restoredSnap = await matchStore.load(id);
  const initialState = restoredSnap?.state ?? newGame({ seats: NET_SEATS });
  // A NET seat is not a bot: every seat here is claimable by a human, and the
  // server-side AI merely stands in for an empty chair (`humans` is the live truth).
  // Strip the static `ai` branding newGame took from the seat config, or two humans
  // on DEFAULT_SETUP seats could never ally (E_BOT_ALLIANCE against seat p2 forever).
  for (const seat of Object.values(initialState.players)) delete seat.ai;
  // Rehydrate idempotency receipts so a retried action stays deduped across a restart.
  const initialReceipts = await receiptStore.loadAll(id);

  const observe = (ev: RoomObservation): void => {
    metrics.observe(ev);
    if (worthLogging(ev)) {
      appendFileSync(logFile, JSON.stringify({ t: Date.now(), match: id, ...ev }) + '\n');
    }
    if (ev.kind === 'join') {
      connected++;
      humans.add(ev.playerId);
      aiEligibleAt.delete(ev.playerId); // the human is back — cancel any pending takeover
    } else if (ev.kind === 'leave') {
      connected = Math.max(0, connected - 1);
      humans.delete(ev.playerId);
      aiEligibleAt.set(ev.playerId, Date.now() + AI_GRACE_MS); // reconnect window
    } else if (ev.kind === 'action') {
      // Persist the receipt so a retried action stays deduped across a restart.
      void receiptStore.save(id, {
        actionId: ev.actionId,
        playerId: ev.playerId,
        seq: ev.seq,
        ok: ev.ok,
        ...(ev.code ? { code: ev.code } : {}),
      });
    }
    // Persist after anything that changes the world (debounced below), and re-arm
    // the offline wakeup: an action may schedule or consume events — both move the
    // next-event time. ('lobby' kept for transport parity; auto-started sessions
    // never emit it — SES-2.1.)
    if (ev.kind === 'action' || ev.kind === 'lobby' || ev.kind === 'end') scheduleSave();
    // Re-arm on room events: an action may (un)schedule events, and a join/leave
    // starts/stops the live-player heartbeat below. A genuine
    // external event also gives the stall guard a fresh chance (the situation may have
    // changed). `advance_overflow` is EXCLUDED: a stalled catch-up emits it from inside
    // `room.tick()` itself, so resetting/re-arming on it would defeat the wake-stall
    // back-off in `onWake` (an eternal 0ms wake spin). The M1 metrics kinds are excluded
    // too: they describe work already done (fan-out size, timings, desync reports) and
    // never move the next-event time — re-arming on every broadcast would churn the timer.
    if (
      ev.kind === 'join' ||
      ev.kind === 'leave' ||
      ev.kind === 'lobby' ||
      ev.kind === 'action' ||
      ev.kind === 'end' ||
      ev.kind === 'dead_letter'
    ) {
      wakeStalls = 0;
      armWakeup();
    }
  };

  // No lobby (SES-2.1, Iron Order model): the session's world clock runs from the
  // moment the session is CREATED, 24/7 — a player always joins a live world (the
  // feed shows which game day it is). There is no host and no Start press to wait
  // for; empty chairs defend themselves until claimed (and the stand-in AI takes
  // an abandoned one after the real-days grace, SES-2.2).
  const room = new MatchRoom({
    id,
    initialState,
    kernel,
    data,
    now: () => Date.now(),
    // Born running: the clock anchors at the initial game time (fresh world: Day 1
    // now; restored snapshot: its saved instant) and TIME_SCALE applies from here.
    initiallyStarted: true,
    singlePeerPerPlayer: true, // one live connection per chair — no two people command one empire
    emitStateHash: true, // attach hashState(view) so the client overlay can flag desync
    observe, // M0: log every room event to JSONL + count for the on-exit summary
    initialReceipts, // rehydrated idempotency (deduped action stays deduped after restart)
    // The kernel context config must match what the local sim (and the HUD) promise:
    // without it victory falls back to its 600 default while the HUD counts to 450.
    config: { timeScale: 1, victory: { scoreLimit: SCORE_LIMIT } },
    initialSeq: restoredSnap?.seq, // resume the action counter — else the optimistic-by-seq
    // store drops post-restart saves until seq climbs back past the stored value
    // Strict commit-before-broadcast: await the durable write of the new snapshot +
    // receipt before the room commits state / broadcasts. The debounced scheduleSave in
    // `observe` above becomes a harmless coalesced extra for actions (still needed for
    // tick-driven advances, which are recomputable and persist after the fact).
    persist: async (snapshot, receipt) => {
      await matchStore.save(snapshot);
      await receiptStore.save(id, receipt);
    },
    timeScale: TIME_SCALE, // playtest fast-forward (1 = real-time)
    // REL-4: the action-layer front-door — envelope validate→authorize→sequence→dedup
    // with per-type payload schemas BEFORE the reducer. Server-internal drivers
    // (AI / standing orders) submit via room.submitAction and are unaffected.
    ...(GATE ? { gate: new ActionGate({ payloadValidator: isValidActionPayload }) } : {}),
  });

  // BF-17: after a (re)start `humans` is empty for EVERY seat — a restarted server
  // must not immediately hand every human's empire to the expand-AI. Seed the same
  // reconnect grace window for all seats; a joining human clears it, a delegated
  // steward bypasses it, and a genuinely empty chair starts playing once it lapses.
  for (const seat of Object.keys(room.state.players)) {
    aiEligibleAt.set(seat, Date.now() + AI_GRACE_MS);
  }

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
        matchId: id,
        dataVersion: room.state.version?.data ?? 'proto',
        seq: room.sequence,
        status: room.state.match.status === 'ended' ? 'ended' : 'ongoing',
        state: room.state,
      });
    } catch (e) {
      process.stderr.write(`snapshot save failed (${id}): ${(e as Error)?.message ?? String(e)}\n`);
    }
    saving = false;
  }

  // Offline scheduler (PA-4.1): a per-room wakeup driver so the world runs
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
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeStalls = 0;
  let driversBusy = false; // re-entrancy guard: one async driver pass at a time
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
  // Drivers submit via room.submitServerAction: on a DURABLE room a raw sync submit
  // would interleave with a commitApply persist await and be silently clobbered
  // (bug-hunt CRIT) — the server entry serializes through the room's actor mailbox.
  async function runServerAI(): Promise<void> {
    if (!room.isStarted || connected === 0) return;
    const now = room.state.time;
    if (now - aiLastAt < 2 * HOUR) return;
    aiLastAt = now;
    for (const seat of Object.keys(room.state.players)) {
      // «Хранитель»: a delegated seat is played by the AI on its posture (defend) even while
      // its owner is connected but asleep; an unclaimed/empty seat gets the full expansion AI.
      const posture = stewardActive(room.state, seat, now);
      if (humans.has(seat) && !posture) continue; // a human is actively commanding this seat
      // Grace window (BF-17): an empty seat without an explicit delegation waits for
      // its human to come back (drop / server restart) before the AI takes the wheel.
      if (!humans.has(seat) && !posture) {
        const eligibleAt = aiEligibleAt.get(seat);
        if (eligibleAt !== undefined && Date.now() < eligibleAt) continue;
      }
      for (const action of aiOrders(room.state, seat, posture ?? 'expand')) {
        await room.submitServerAction(seat, action);
      }
    }
  }

  // CC-2 / CC-4: drive the authoritative STANDING orders (auto-storm + дежурный вылет)
  // server-side — the pure decisions live in game.ts
  // (serverAutoAssaultActions / serverPatrolActions, tested); this just applies them
  // through the authoritative room. A rejected storm is simply skipped (a standing
  // stance has no chain to block); patrol runtime state persists via patrol.stamp.
  async function runServerStanding(): Promise<void> {
    if (!room.isStarted) return;
    for (const a of serverAutoAssaultActions(room.state)) {
      for (const act of a.actions) if (!(await room.submitServerAction(a.owner, act)).ok) break;
    }
    for (const p of serverPatrolActions(room.state, room.state.time)) {
      if (p.drop) {
        if (p.owner) await room.submitServerAction(p.owner, orderScramble(p.owner, p.fleetId, false));
        continue;
      }
      if (p.patch) {
        await room.submitServerAction(p.owner, patrolStamp(p.owner, p.fleetId, p.patch.sortie, p.patch.rearmAt));
      }
      for (const act of p.actions) await room.submitServerAction(p.owner, act);
    }
  }

  function onWake(): void {
    wakeTimer = null;
    const progressed = room.tick(); // fire whatever is now due (no-op if a capped timer fired early)
    // Stall guard: work is due (ms 0) but the clock didn't move ⇒ a same-instant runaway.
    // While stalled, SKIP the AI/standing-order drivers — their submissions (even rejected ones)
    // emit `action` observations that would reset this guard and re-arm a 0ms wake — and
    // back off after a few tries instead of busy-looping (the room has already surfaced
    // an advance_overflow). A real player action re-arms via `observe`, which resets the
    // counter and gives it a fresh chance.
    const stalled = !progressed && room.msUntilNextEvent() === 0;
    if (!stalled && !driversBusy) {
      wakeStalls = 0;
      // Async drivers (durable rooms await the mailbox); the busy flag stops a later
      // heartbeat from double-running them while a slow persist is still in flight.
      driversBusy = true;
      void (async () => {
        try {
          await runServerAI(); // drive any empty seat once the clock has moved
          await runServerStanding(); // CC-2/CC-4: standing orders (auto-storm / дежурный вылет)
        } finally {
          driversBusy = false;
        }
      })();
    }
    scheduleSave(); // persist the advanced world
    if (stalled && ++wakeStalls >= WAKE_STALL_LIMIT) {
      process.stderr.write(
        `wakeup driver idling (${id}): the world clock stalled (a same-instant scheduling loop) — ` +
          'check for a module scheduling events at its own instant.\n',
      );
      return; // idle — do not re-arm
    }
    armWakeup(); // re-arm for the next event (or the remainder of a long sleep)
  }

  return {
    id,
    room,
    restored: !!restoredSnap,
    armWakeup,
    flush: doSave,
    clearTimers(): void {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (wakeTimer) {
        clearTimeout(wakeTimer);
        wakeTimer = null;
      }
    },
  };
}

// Raise every hosted session, then expose them ALL through the registry so the
// client's match browser (GET /matches) lists each with its real status
// (map / rules / day / players) and joins go to `/matches/<id>`.
const hosted: HostedMatch[] = [];
for (const id of matchIds) hosted.push(await createHostedMatch(id));
const restoredCount = hosted.filter((h) => h.restored).length;
const registry = new MatchRegistry(accountStore);
for (const h of hosted) {
  registry.register(h.room, {
    mapId: 'nexus',
    rules: { timeScale: TIME_SCALE },
    createdAt: Date.now(),
    startedAt: h.room.state.time,
  });
}
const server = createMultiplayerServer({
  registry,
  host,
  port,
  indexHtml,
  accountStore, // `?nick=` WS login resolves its seat here
  seatLock: SEAT_LOCK, // REL-5: nick+ticket identity; `?player=` refused when on
  // The match-browser read-model + archive intents (GET /matches, POST …/archive),
  // plus the dev client at `/dev` when the player build owns `/` (same no-store
  // headers as `/` — a stale dev client is as confusing as a stale player one).
  httpRoutes: (app) => {
    registerBrowserApi(app, registry);
    if (playerHtml !== undefined && devHtml !== undefined) {
      app.get('/dev', async (_request, reply) => {
        void reply.header('content-type', 'text/html; charset=utf-8');
        void reply.header('cache-control', 'no-store, must-revalidate');
        return devHtml;
      });
    }
  },
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
const httpUrl = wsUrl.replace(/^ws/, 'http').replace(/\/matches.*$/, '');

// Pick the address a friend actually dials: a real LAN/public IPv4, never a
// VM-NAT/link-local one. `pnpm doctor` prints the full reachability breakdown.
const addrs = host === '0.0.0.0' ? ipv4s() : [];
const shareIp =
  addrs.find((a) => ipKind(a) === 'public') ?? addrs.find((a) => ipKind(a) === 'lan') ?? null;
const onLan = shareIp !== null;
const unreachableOnly = host === '0.0.0.0' && !onLan && addrs.length > 0;
const localHttp = httpUrl.replace('0.0.0.0', 'localhost'); // 0.0.0.0 isn't openable
const friendUrl = onLan ? `http://${shareIp}:${port}/` : null;
const liveSeatIds = Object.keys(hosted[0]!.room.state.players);
const firstSeat = liveSeatIds[0] ?? 'p1';
const lastSeat = liveSeatIds.at(-1) ?? firstSeat;

const lines = [
  'Void Dominion — prototype dev server (real core)',
  indexHtml
    ? playerHtml
      ? `  game   : ${localHttp}/   (player client · dev client with test tools: ${localHttp}/dev)`
      : `  game   : ${localHttp}/   (open in a browser → Connect)`
    : `  game   : run \`pnpm prototype\` first to serve the HTML at /`,
  `  health : ${localHttp}/health`,
  DATABASE_URL
    ? `  store  : Postgres — durable${restoredCount > 0 ? ` (resumed ${restoredCount} saved match${restoredCount > 1 ? 'es' : ''})` : ''}`
    : '  store  : in-memory — a restart loses the matches (set DATABASE_URL for durability)',
  GATE
    ? '  gate   : ON — only validated action.v1 envelopes (clients auto-detect via welcome.gated)'
    : '  gate   : off — bare actions accepted (set GATE=1 for the release posture)',
  SEAT_LOCK
    ? '  seats  : LOCKED — a nick’s first join mints a ticket its client must present to reconnect'
    : '  seats  : open — any nick takes any free seat (set SEAT_LOCK=1 for the release posture)',
  TIME_SCALE > 1
    ? `  time   : ×${TIME_SCALE} fast-forward (1 real min ≈ ${(TIME_SCALE / 60).toFixed(1)} game-hours) — playtest mode`
    : '  time   : ×1 real-time (set TIME_SCALE=100 to fast-forward a playtest)',
  `  matches: ${MATCHES} session${MATCHES > 1 ? 's' : ''} in this process (${matchIds.join(', ')}) — set MATCHES=N for more; all listed in the in-game browser`,
  NETWORK_MODE === '2v2'
    ? '  mode   : 2v2 team battle — 4 claimable chairs each; empty chairs are AI-driven'
    : NETWORK_MODE === '5v5'
      ? '  mode   : 5v5 team battle — 10 claimable chairs each; empty chairs are AI-driven'
      : '  mode   : 10-player FFA — empty chairs are AI-driven (set TEAMS=5v5 for teams)',
  '',
  '  Multiplayer test:',
  `   • You:     open ${localHttp}/  → enter a callsign → join`,
  onLan
    ? `   • Friends: open ${friendUrl}  (same Wi-Fi) → enter unique callsigns → join a free chair`
    : '   • Friends: run `pnpm host` (binds 0.0.0.0 → prints a LAN URL), or tunnel the port for remote players — see docs/multiplayer.md',
];
if (unreachableOnly) {
  lines.push(
    `   ⚠ only a non-routable address (${addrs.join(', ')}) — VM-NAT/link-local, unreachable off this box.`,
    `     Remote friend? Tunnel it:  cloudflared tunnel --url http://localhost:${port}   (or run \`pnpm doctor\`)`,
  );
}
// With ONE match listen() returns its full URL; with several it returns the base
// prefix (the client appends /<matchId>) — the printed example always shows a full,
// dialable URL for the first match.
const rawWs = (MATCHES === 1 ? wsUrl : `${wsUrl}/${matchIds[0]}`).replace('0.0.0.0', 'localhost');
lines.push(
  '',
  SEAT_LOCK
    ? `  raw ws : ${rawWs}?nick=<name>  (seat lock on — ?player= is refused)`
    : `  raw ws : ${rawWs}?player=${firstSeat}  ·  …?player=${lastSeat}`,
  '',
);
process.stdout.write(lines.join('\n'));

// Start the offline heartbeat per room: if a restored match already has a due/pending
// event, this arms its first wake (no burst — the clock resumes at the saved time).
for (const h of hosted) h.armWakeup();

// On Ctrl-C: print the playtest summary (counts gathered by `observe`) and where
// the raw JSONL landed, then close cleanly — the per-match data survives the run.
const printSummary = (): void => {
  const s = metrics.summary();
  const fmt = (m: Record<string, number>): string =>
    Object.entries(m)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ') || '—';
  const ms = (x: { avg: number; max: number; count: number }): string =>
    x.count === 0 ? '—' : `avg ${x.avg.toFixed(1)}ms · max ${x.max.toFixed(1)}ms (${x.count})`;
  const kb = (x: { avg: number; max: number; count: number }): string =>
    x.count === 0 ? '—' : `avg ${(x.avg / 1024).toFixed(2)}KB · max ${(x.max / 1024).toFixed(2)}KB`;
  process.stdout.write(
    [
      '',
      '── playtest summary ──────────────────────────────',
      `  joins ${s.joins} · leaves ${s.leaves} · actions ${s.actions.total} (ok ${s.actions.ok} · rejects ${s.actions.rejected})`,
      `  by type   : ${fmt(s.actions.byType)}`,
      `  by reject : ${fmt(s.actions.rejectByCode)}`,
      `  battles ${s.battles} · captures ${s.captures} · desyncs ${s.desyncs} · dead-letters ${s.deadLetters} · overflows ${s.advanceOverflows}`,
      `  submit    : ${ms(s.submitMs)}`,
      `  advance   : ${ms(s.advanceMs)}`,
      `  broadcast : ${ms(s.broadcastMs)} · delta ${kb(s.deltaBytes)}`,
      s.clientFps
        ? `  client    : fps avg ${s.clientFps.avg.toFixed(0)} · min ${s.clientFps.min.toFixed(0)}` +
          (s.clientRttMs ? ` · rtt avg ${s.clientRttMs.avg.toFixed(0)}ms · max ${s.clientRttMs.max.toFixed(0)}ms` : '')
        : '  client    : — (перф-сэмплы не приходили)',
      s.end
        ? `  match end : winner ${s.end.winner ?? '—'}${s.end.reason ? ` (${s.end.reason})` : ''}`
        : '  match end : —',
      `  log file  : ${logFile}`,
      '──────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
};

const shutdown = (): void => {
  printSummary();
  // M3: land the aggregated summary as the LAST JSONL line — the per-line log keeps
  // only anomalous broadcast/timing entries, so without this the report script would
  // have no full latency/delta aggregates to read.
  try {
    appendFileSync(logFile, JSON.stringify({ t: Date.now(), kind: 'summary', summary: metrics.summary() }) + '\n');
  } catch {
    /* the report just falls back to the partial per-line data */
  }
  for (const h of hosted) h.clearTimers();
  void (async () => {
    // Final flush per room so the latest state of EVERY session is durable before exit.
    for (const h of hosted) await h.flush();
    if (pool) await pool.end();
    await server.close();
    process.exit(0);
  })();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
