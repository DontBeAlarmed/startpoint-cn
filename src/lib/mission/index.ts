// lib/mission barrel — unified mission system

// Types
export type { MissionComputer, CategoryContext, ComputerRegistry, PlayerQuestProgressEntry } from "./types"
export type { FactIdSelection, FactKey, PeriodicSnapshotKind } from "./facts/fact-key"
export type { MissionFactLoadPlan } from "./facts/types"
export { getFactKeyId, normalizeFactKey } from "./facts/fact-key"
export { buildFactLoadPlan } from "./facts/load-plan"
export type {
    MissionFactLoader,
    MissionFactLoaderContext,
    MissionFactValue,
    MissionFactValueByKind,
} from "./fact-loaders"
export { MissionFactLoaderRegistry } from "./fact-loaders"
export type { ProductionMissionFactDomains } from "./production-fact-loaders"
export { createProductionMissionFactLoaderRegistry } from "./production-fact-loaders"
export type {
    MissionFactRequirement,
    MissionFactRequirementEntry,
    MissionFactRequirementRegistry,
    MissionRef,
} from "./requirements/types"
export { getMissionFactRequirementRegistry } from "./requirements/registry"
export type {
    MissionEvaluationCandidateRequirement,
    MissionEvaluationObserver,
    MissionEvaluationSessionOptions,
} from "./evaluation-session"
export { MissionEvaluationSession } from "./evaluation-session"

// Registry
export { getComputer } from "./registry"

// Snapshot-scoped standard mission catalog
export type { MissionCatalog, MissionCatalogReward, MissionCatalogStage, MissionMasterDefinition } from "./mission-catalog"
export { getMissionCatalog } from "./mission-catalog"

// Stages
export { getMissionIdsByCategory, getCurrentStage, getCompletedStageNumbers, getMissionStageIds, isMissionProgressComplete } from "./stages"

// Rewards
export type { ActiveMissionReward, AwakeMissionRewardStageDefinition, AwakeMissionSpecialReward, MissionRewardStageDefinition } from "./rewards"
export { getActiveMissionRewards, getAwakeMissionRewards, getAwakeMissionRewardStageDefinition, getCollectMissionRewards, getDailyMissionRewards, getDegreeMissionRewards, getEventMissionRewards, getMissionRewardStageDefinition, getRegularMissionRewards, getWeeklyMissionRewards } from "./rewards"
export type { MissionSettlementInfo, MissionSettlementResult, MissionSettlementScope } from "./settlement"
export { settleMissionCategories, settleMissionCategoriesWithEvaluation } from "./settlement"
export type { MissionSettlementEvaluation } from "./settlement"
export { evaluateMissionProgressStageB, getMissionProgressStageBRefs } from "./progress-stage-b"
export { mergeMissionSettlementResponse } from "./response"

// Patterns (for update_mission_progress)
export type { PatternMatch } from "./patterns"
export { getMissionsByPattern, getMissionDefinition, getMissionPattern, isComputablePattern, isMissionEnabledAt } from "./patterns"

export type { MissionRewardClaimContext, MissionRewardClaimValidation, ValidatedMissionRewardClaim } from "./claims"
export { validateMissionRewardClaims } from "./claims"

export type {
    ActiveMissionAvailabilityContext,
    ActiveMissionProgressSettlement,
    ActiveMissionProgressSettlementOptions,
    ActiveMissionProgressState,
    ParsedActiveMissionDefinition,
    ParsedActiveMissionEventDefinition,
} from "./active-core"
export {
    getActiveMissionEventReleasePhase,
    isActiveMissionAvailable,
    isActiveMissionClaimable,
    parseActiveMissionDefinition,
    parseActiveMissionEventDefinition,
    parseCnMasterDateTime,
    parseJstDateTime,
    settleActiveMissionProgress,
} from "./active-core"
export type { ActiveMissionEventEligibilityContext, ReconcileActiveMissionFactsInput } from "./active-reconciliation"
export {
    reconcileActiveMissionFacts,
    reconcileActiveMissionFactsWithResult,
    resolveActiveMissionQuestIds,
} from "./active-reconciliation"

// Character queries
export { getCharacterStoryQuestIds, getCharacterIdFromMission } from "./character-queries"

// Awake summary (for /load response)
export { computeAwakeSummary } from "./compute-awake-summary"
export type { AwakeRequestContext, CreateAwakeRequestContextOptions } from "./awake-request-context"
export { createAwakeRequestContext } from "./awake-request-context"
export type { AwakeBattleMissionSettlementParams, AwakeMissionComputedProgress, AwakeMissionInfo, AwakeMissionSettlementEvaluation, AwakeMissionSettlementResult } from "./awake-settlement"
export { getAwakeBattleMissionIds, settleAwakeBattleMissions, settleAwakeMissionCandidates, settleAwakeMissionCandidatesWithEvaluation, settleAwakeMissionRewards } from "./awake-settlement"
export type { AwakeUnlockProgress, AwakeUnlockReconciliationResult } from "./awake-unlock"
export { reconcileAwakeUnlocks, reconcileAwakeUnlocksFromProgress } from "./awake-unlock"
export type { CharacterAwakeBaseReadiness, CharacterAwakeEligibilityResolver, CharacterAwakeEligibilitySnapshot } from "./awake-eligibility"
export { createCharacterAwakeEligibilityResolver, createCharacterAwakeEligibilityResolverFromSnapshot, getCharacterAwakeBaseReadiness, isCharacterAwakeBaseReady, isCharacterAwakeNewUnlockEligible } from "./awake-eligibility"
export type { ReconcileAwakeUnlockCharacterListOptions } from "./awake-unlock-response"
export {
    reconcileAwakeUnlockCharacterList,
    reconcileAwakeUnlockCharacterListBestEffort,
    reconcileAwakeUnlockCharacterListStrict,
} from "./awake-unlock-response"

// Degree helpers
export { getTargetDegree } from "./computer-degree"
export { getDegreeMissionIdsForConditionTypes } from "./degree-candidates"

// Filter (active mission ID filtering, C8601 prevention)
export { isActiveMissionId, filterToActiveMissions } from "./filter"
