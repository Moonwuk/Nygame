/**
 * @void/shared-core — the deterministic, data-driven simulation core.
 *
 * The same package runs on the server (authority) and the client (preview):
 * docs/architecture.md §3. It depends on no server, database or network.
 */

// Determinism
export { Rng, seedRng, type RngState } from './rng/rng';

// State model
export {
  createInitialState,
  scientistsOf,
  type GameState,
  type GameVersion,
  type Player,
  type Planet,
  type PlanetSnapshot,
  type FogMemory,
  type Hero,
  type TempLane,
  type MarketOrder,
  type Fleet,
  type FleetMovement,
  type FleetEdge,
  type Battle,
  type BattleSide,
  type CombatantRef,
  type ScheduledEvent,
  type UnitStack,
  type BuildingInstance,
  type ActiveResearch,
  type PlayerTechnologyState,
  type StewardState,
  type ResourceBag,
  type PlayerId,
  type PlanetId,
  type FleetId,
  type BattleId,
  type ResourceId,
  type UnitId,
  type ModuleId,
  type BuildingId,
  type TechnologyId,
  type TraitId,
  type MatchStatus,
  type MatchEndReason,
  type MatchScore,
  type MatchState,
  type DiplomaticStance,
  type IntelGrant,
} from './state/gameState';
export {
  buildStateFromMap,
  validateMatchMap,
  type BuildFromMapOptions,
  type SlotAssignment,
} from './state/buildFromMap';
export {
  sectorKindDef,
  isCapturable,
  isBuildable,
  hasOrbit,
  allowedBuildings,
  sectorAppearance,
} from './state/sectorKind';
export { factionStart, type FactionStart } from './state/factionStart';
export { planRoute, routeDistance, fleetBaseSpeed, estimateTravelHours } from './state/route';
export { isBombarded, bombardedPlanets } from './state/orbit';
export {
  DEFAULT_STANCE,
  STANCE_RANK,
  pairKey,
  pairHas,
  getStance,
  setStance,
  isBotPair,
  offerKey,
  offerInvolves,
  getOffer,
  setOffer,
  clearOffers,
  stanceToRelation,
  type DiplomaticRelation,
  type DiplomacyCapability,
} from './state/diplomacy';
export { diffState, applyDelta, type StateDelta } from './state/delta';
export { visibleState, visibleView, identifiedNodes, isVisibleTo } from './state/visibility';
export type { VisibleState, VisibleView, SignatureContact, SignatureSize } from './state/visibility';
export { hashState } from './state/hash';

// Action contract
export {
  Rejection,
  parseActionId,
  timeScaleOf,
  type Action,
  type Context,
  type MatchConfig,
  type VictoryConfig,
  type DomainEvent,
  type ApplyResult,
  type AdvanceResult,
  type AdvanceFailure,
  type ActionIdParts,
} from './action/types';
export { isValidActionPayload } from './actions/payloadSchemas';

// Microkernel
export { Kernel, createKernel } from './kernel/kernel';
export type {
  GameModule,
  ModuleSetupApi,
  HandlerContext,
  ActionHandler,
  EventHandler,
  HookFn,
  ModuleManifest,
  ModuleManifestEntry,
} from './kernel/module';

// Map-as-content (data-driven match setup)
export {
  MatchMapSchema,
  MapSectorSchema,
  MapSlotSchema,
  SpawnPolicySchema,
  parseMatchMap,
  safeParseMatchMap,
  type MatchMap,
  type MapSector,
  type MapSlot,
  type SpawnPolicy,
} from './data/mapSchema';

// Data-driven content
export {
  parseGameData,
  safeParseGameData,
  buildingLevel,
  buildingMaxLevel,
  GameDataSchema,
  UnitDefSchema,
  FactionDefSchema,
  BuildingDefSchema,
  BuildingLevelSchema,
  EffectRuleSchema,
  SectorTypeDefSchema,
  SectorKindDefSchema,
  PlanetTypeDefSchema,
  TechnologyDefSchema,
  TechnologyConditionSchema,
  ScientistDefSchema,
  HeroArchetypeDefSchema,
  HeroAbilityDefSchema,
  HeroPassiveDefSchema,
  HeroSkillNodeSchema,
  HeroBranchSchema,
  TechnologyEffectsSchema,
  TechnologyUnlocksSchema,
  ResourceBagSchema,
  UnitStatsSchema,
  ModuleDefSchema,
  ModuleEffectsSchema,
  ModuleAllowedSchema,
  ShipSlotsSchema,
  ShipSlotTypeSchema,
  SHIP_SLOT_TYPES,
  type GameData,
  type UnitDef,
  type ModuleDef,
  type ModuleEffects,
  type ShipSlots,
  type ShipSlotType,
  type FactionDef,
  type FactionLoadout,
  type FactionPassives,
  type StartingStack,
  type BuildingDef,
  type BuildingLevel,
  type EffectRule,
  type SectorTypeDef,
  type SectorKindDef,
  type SectorKindAppearance,
  type PlanetTypeDef,
  type TechnologyDef,
  type TechnologyCondition,
  type ScientistDef,
  type HeroArchetypeDef,
  type HeroAbilityDef,
  type HeroPassiveDef,
  type HeroSkillNode,
  type HeroSkillGrants,
  type HeroShip,
  type HeroBranch,
  type TechnologyEffects,
  type TechnologyUnlocks,
  type UnitStats,
} from './data/schemas';
export { composeGameDataBundle, loadGameData, type JsonReader } from './data/loadGameData';

// Utilities
export { deepClone, deepFreeze } from './util/clone';
export { MS_PER_HOUR, MS_PER_DAY } from './util/time';
export { findHealthyStack, addUnits, sumUnitStat } from './util/stacks';
export {
  effectiveStats,
  slotUsage,
  moduleAllowed,
  canEquip,
  validateLoadout,
  loadoutCost,
  hullSlotTypes,
  type SlotCounts,
} from './util/loadout';
export { requireOwnedIdleFleet, type IdleFleet } from './util/fleet';

// Base modules (plugins) — opt-in via the manifest passed to createKernel.
export { economyModule, BROWNOUT } from './modules/economy';
export { movementModule } from './modules/movement';
export { combatModule } from './modules/combat';
export { orbitalModule } from './modules/orbital';
export { artilleryModule } from './modules/artillery';
export { interceptModule } from './modules/intercept';
export { captureOnArrivalModule } from './modules/captureOnArrival';
export { sectorModule } from './modules/sector';
export { planetTypeModule } from './modules/planetType';
export { constructionModule } from './modules/construction';
export { stationModule } from './modules/station';
export { technologyModule, technologyLock } from './modules/technology';
export { scientistModule } from './modules/scientist';
export { factionModule } from './modules/faction';
export { armyModule } from './modules/army';
export { victoryModule } from './modules/victory';
export { visibilityModule } from './modules/visibility';
export { heroModule } from './modules/hero';
export type { HeroEffect, HeroEffectArgs } from './modules/hero';
export {
  stewardModule,
  stewardActive,
  STEWARD_POSTURES,
  type StewardPosture,
} from './modules/steward';
export { marketModule } from './modules/market';
export { espionageModule } from './modules/espionage';
export { diplomacyModule } from './modules/diplomacy';
