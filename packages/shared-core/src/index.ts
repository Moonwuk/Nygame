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
  type PausedConstructionSite,
  type ActiveResearch,
  type PlayerTechnologyState,
  type StewardState,
  type StewardLogEntry,
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
  type PlayerArsenal,
  type PlayerReward,
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
} from './state/sectorKind';
export { factionStart, type FactionStart } from './state/factionStart';
export {
  planRoute,
  routeDistance,
  fleetBaseSpeed,
  estimateTravelHours,
  journeyDestination,
  journeyEtaMs,
} from './state/route';
export { isBombarded, bombardedPlanets, isActivelyBombarding } from './state/orbit';
export { fleetPositionAt, fleetNodeAt, legT } from './state/fleetPosition';
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
export {
  previewBattle,
  previewLossCount,
  hullPool,
  type BattlePreview,
  type BattlePreviewSide,
} from './state/previewBattle';
export { scanNodeThreats, type NodeThreat } from './state/threat';

// Action contract
export {
  Rejection,
  parseActionId,
  timeScaleOf,
  hoursToMs,
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

// Arsenal — the persistent meta-inventory contract (ARS-1; ownership lives on the
// server, the core only speaks the item shape for snapshots/validation)
export {
  ArsenalItemSchema,
  ArsenalItemKindSchema,
  ArsenalItemFormSchema,
  ArsenalOriginSchema,
  parseArsenalItem,
  safeParseArsenalItem,
  validateArsenalItem,
  type ArsenalItem,
  type ArsenalItemKind,
  type ArsenalItemForm,
  type ArsenalOrigin,
} from './data/arsenalSchema';

// Map-as-content (data-driven match setup)
export {
  MatchMapSchema,
  MapSectorSchema,
  MapSlotSchema,
  SpawnPolicySchema,
  avaShape,
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
  HeroFittingDefSchema,
  HeroBranchSchema,
  TechnologyEffectsSchema,
  TechnologyUnlocksSchema,
  ResearchBoostDefSchema,
  ResourceBagSchema,
  RewardsDefSchema,
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
  type HeroFittingDef,
  type HeroShip,
  type HeroBranch,
  type TechnologyEffects,
  type TechnologyUnlocks,
  type UnitStats,
  type RewardsDef,
  type ResearchBoostDef,
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
export {
  canInstall,
  validateInstalled,
  type FittingSpec,
  type InstallFailure,
} from './util/fitting';
export { requireOwnedIdleFleet, type IdleFleet } from './util/fleet';
export { buildProgress, thresholdRamp } from './util/construction';

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
export { heroEffectsModule } from './modules/heroEffects';
export {
  stewardModule,
  stewardActive,
  STEWARD_POSTURES,
  STEWARD_LOSS_LIMIT,
  MAX_STEWARD_LOG,
  MAX_STEWARD_HOLD_POINTS,
  type StewardPosture,
} from './modules/steward';
export { effectsModule, type EffectImpl, type EffectOccurrence } from './modules/effects';
export { defHasTrait, unitHasTrait, stacksHaveTrait } from './data/traits';
export { marketModule } from './modules/market';
export { espionageModule } from './modules/espionage';
export { diplomacyModule } from './modules/diplomacy';
