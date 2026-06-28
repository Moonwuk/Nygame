/* Node smoke-test: drives the prototype game wiring through the real kernel. */
import {
  newGame,
  advance,
  order,
  HOUR,
  moveFleet,
  orbitFleet,
  assaultFleet,
  buildUnit,
  buildBuilding,
  launchFleet,
} from './game';

function treas(s: ReturnType<typeof newGame>, p: string) {
  const r = s.players[p]?.resources ?? {};
  return `credits ${Math.floor(r.credits ?? 0)}, metal ${Math.floor(r.metal ?? 0)}`;
}

let s = newGame();
const log: string[] = [];
const note = (t: number, msg: string) => log.push(`  [${(t / HOUR).toFixed(0)}h] ${msg}`);

// 1) economy accrues over 5h
let r = advance(s, 5 * HOUR);
s = r.state;
note(s.time, `p1 treasury after 5h: ${treas(s, 'p1')}`);

// 2) order a refinery + a cruiser at C1R1
r = order(s, buildBuilding('p1', 'C1R1', 'refinery'), s.time);
s = r.state;
note(s.time, `build refinery @C1R1 → ${r.error ?? 'ok'}`);
r = order(s, buildUnit('p1', 'C1R1', 'cruiser', 1), s.time);
s = r.state;
note(s.time, `build cruiser @C1R1 → ${r.error ?? 'ok'}`);

// 3) send the blue fleet to take a nearby neutral world
r = order(s, moveFleet('p1', 'p1-1', 'C3R3'), s.time);
s = r.state;
note(s.time, `move blue-1 → C3R3 → ${r.error ?? 'ok'}`);

// 4) run the world forward; when blue-1 is idle over a hostile world, descend & land
for (let t = s.time + HOUR; t <= 40 * HOUR; t += HOUR) {
  r = advance(s, t);
  s = r.state;
  const b = s.fleets['p1-1'];
  if (b && b.location && !b.movement && !b.battleId && s.planets[b.location]?.owner !== 'p1') {
    if (b.orbit !== 'near') {
      r = order(s, orbitFleet('p1', 'p1-1', 'near'), s.time);
      if (r.state) s = r.state;
    }
    r = order(s, assaultFleet('p1', 'p1-1'), s.time);
    if (!r.error) s = r.state;
  }
  for (const e of r.events) {
    if (
      e.type === 'battle.started' ||
      e.type === 'battle.resolved' ||
      e.type === 'planet.captured' ||
      e.type === 'building.constructed' ||
      e.type === 'unit.built' ||
      e.type === 'building.destroyed'
    ) {
      note(s.time, `${e.type} ${JSON.stringify(e.payload)}`);
    }
  }
}

note(s.time, `C3R3 owner = ${s.planets.C3R3?.owner}`);
note(s.time, `C1R1 garrison = ${JSON.stringify(s.planets.C1R1?.garrison)}`);

// 5) launch a fresh fleet from C1R1's garrison
r = order(s, launchFleet('p1', 'C1R1'), s.time);
s = r.state;
note(s.time, `launch fleet @C1R1 → ${r.error ?? 'ok'}`);
const launched = Object.values(s.fleets).find((f) => f.owner === 'p1' && f.location === 'C1R1');
note(s.time, `launched fleet units = ${JSON.stringify(launched?.units)} landing=${JSON.stringify(launched?.landing)}`);

note(s.time, `final p1 treasury: ${treas(s, 'p1')}`);
note(s.time, `fleets: ${Object.keys(s.fleets).join(', ')}`);

// eslint-disable-next-line no-console
console.log('=== Void Dominion prototype smoke ===\n' + log.join('\n'));
