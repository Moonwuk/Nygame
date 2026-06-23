import type { MatchEndReason, MatchScore, PlayerId, UnitStack } from '../state/gameState';
import type { GameData } from '../data/schemas';
import type { HandlerContext, GameModule } from '../kernel/module';

const DEFAULT_DOMINATION_PERCENT = 0.6;
/** Score for merely controlling a node — even a planetless system is worth holding. */
const CONTROL_BASE = 10;

function emptyScore(): MatchScore {
  return { controlledPlanets: 0, fleets: 0, units: 0, total: 0 };
}

/** Tallies a unit list: every unit raises the headcount (used for the alive
 *  check), but only super-units add to the score (ordinary military never does). */
function addUnits(score: MatchScore, stacks: readonly UnitStack[], data: GameData): void {
  for (const stack of stacks) {
    score.units += stack.count;
    const def = data.units[stack.unit];
    if (def?.superUnit) {
      score.total += def.scoreValue * stack.count;
    }
  }
}

function computeScores(h: HandlerContext): Record<PlayerId, MatchScore> {
  const data = h.ctx.data;
  const scores: Record<PlayerId, MatchScore> = {};
  for (const playerId of Object.keys(h.state.players)) {
    scores[playerId] = emptyScore();
  }

  for (const planet of Object.values(h.state.planets)) {
    if (planet.owner === null) {
      continue;
    }
    const score = scores[planet.owner];
    if (!score) {
      continue;
    }
    score.controlledPlanets += 1;
    // Territory worth: base control + planet nature + sector terrain + structures
    // (a building scales with its level, so investment — and its loss — shows).
    score.total += CONTROL_BASE;
    const planetType = planet.planetType ? data.planetTypes[planet.planetType] : undefined;
    if (planetType) {
      score.total += planetType.scoreValue;
    }
    const sector = planet.sectorType ? data.sectors[planet.sectorType] : undefined;
    if (sector) {
      score.total += sector.scoreValue;
    }
    for (const building of planet.buildings) {
      const def = data.buildings[building.type];
      if (def) {
        score.total += def.scoreValue * building.level;
      }
    }
    addUnits(score, planet.garrison, data);
  }

  for (const fleet of Object.values(h.state.fleets)) {
    const score = scores[fleet.owner];
    if (!score) {
      continue;
    }
    score.fleets += 1;
    addUnits(score, fleet.units, data);
    addUnits(score, fleet.landing ?? [], data);
  }

  return scores;
}

/** A player is still in the running while they hold any asset — a planet, a
 *  fleet or any units. Kept independent of `total` so the score formula (where
 *  ordinary military scores nothing) can't mistake a fleet-only player for dead. */
function hasAssets(score: MatchScore): boolean {
  return score.controlledPlanets + score.fleets + score.units > 0;
}

function highestScore(
  scores: Record<PlayerId, MatchScore>,
  playerIds: readonly PlayerId[],
): PlayerId | null {
  let winner: PlayerId | null = null;
  let best = -Infinity;
  let tied = false;
  for (const playerId of [...playerIds].sort()) {
    const total = scores[playerId]?.total ?? 0;
    if (total > best) {
      best = total;
      winner = playerId;
      tied = false;
    } else if (total === best) {
      tied = true;
    }
  }
  return tied ? null : winner;
}

function endMatch(h: HandlerContext, winner: PlayerId | null, reason: MatchEndReason): void {
  h.state.match.status = 'ended';
  h.state.match.winner = winner;
  h.state.match.endedAt = h.ctx.now;
  h.state.match.reason = reason;
  h.emit('match.ended', {
    winner,
    reason,
    at: h.ctx.now,
    scores: h.state.match.scores,
  });
}

function evaluateVictory(h: HandlerContext): void {
  if (h.state.match.status === 'ended') {
    return;
  }

  const scores = computeScores(h);
  h.state.match.scores = scores;

  const playerIds = Object.keys(h.state.players).sort();
  const activeBefore = playerIds.filter(
    (playerId) => h.state.players[playerId]?.status === 'active',
  );
  if (activeBefore.length < 2) {
    return;
  }

  const contenders = activeBefore.filter((playerId) => {
    const score = scores[playerId];
    return score ? hasAssets(score) : false;
  });
  if (contenders.length > 0) {
    for (const playerId of activeBefore) {
      if (!contenders.includes(playerId)) {
        const player = h.state.players[playerId];
        if (player) {
          player.status = 'defeated';
        }
      }
    }
  }

  const active = playerIds.filter((playerId) => h.state.players[playerId]?.status === 'active');
  if (active.length === 1 && activeBefore.length > 1) {
    endMatch(h, active[0] ?? null, 'elimination');
    return;
  }

  const totalPlanets = Object.keys(h.state.planets).length;
  const dominationPercent = h.ctx.config?.victory?.dominationPercent ?? DEFAULT_DOMINATION_PERCENT;
  if (totalPlanets > 0 && dominationPercent > 0) {
    const dominator = active.find(
      (playerId) => (scores[playerId]?.controlledPlanets ?? 0) / totalPlanets >= dominationPercent,
    );
    if (dominator) {
      endMatch(h, dominator, 'domination');
      return;
    }
  }

  const scoreLimit = h.ctx.config?.victory?.scoreLimit;
  if (scoreLimit !== undefined) {
    const winner = highestScore(
      scores,
      active.filter((playerId) => (scores[playerId]?.total ?? 0) >= scoreLimit),
    );
    if (winner) {
      endMatch(h, winner, 'score');
      return;
    }
  }

  const endsAt = h.ctx.config?.victory?.endsAt;
  if (endsAt !== undefined && h.ctx.now >= endsAt) {
    endMatch(h, highestScore(scores, active), 'timeout');
  }
}

/**
 * Victory — terminal match state and scoreboard. It observes world events and
 * evaluates only from the authoritative state: map domination, elimination,
 * score-limit and timeout wins.
 */
export const victoryModule: GameModule = {
  id: 'victory',
  version: '1.0.0',
  setup(api) {
    api.on('time.advanced', (_event, h) => evaluateVictory(h));
    api.on('planet.captured', (_event, h) => evaluateVictory(h));
    api.on('fleet.destroyed', (_event, h) => evaluateVictory(h));
    api.on('battle.resolved', (_event, h) => evaluateVictory(h));
    api.on('unit.built', (_event, h) => evaluateVictory(h));
  },
};
