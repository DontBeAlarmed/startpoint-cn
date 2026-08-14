// lib/mission barrel — unified mission system

// Types
export type { MissionComputer, CategoryContext, ComputerRegistry, PlayerQuestProgressEntry } from "./types"

// Registry
export { getComputer } from "./registry"

// Stages
export { getMissionIdsByCategory, getCurrentStage, getCompletedStageNumbers, getMissionStageIds, isMissionProgressComplete } from "./stages"

// Rewards
export type { ActiveMissionReward, AwakeMissionRewardStageDefinition, AwakeMissionSpecialReward, MissionRewardStageDefinition } from "./rewards"
export { getActiveMissionRewards, getAwakeMissionRewards, getAwakeMissionRewardStageDefinition, getCollectMissionRewards, getDailyMissionRewards, getDegreeMissionRewards, getEventMissionRewards, getMissionRewardStageDefinition, getRegularMissionRewards, getWeeklyMissionRewards } from "./rewards"
export type { MissionSettlementInfo, MissionSettlementResult, MissionSettlementScope } from "./settlement"
export { settleMissionCategories } from "./settlement"
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
export { reconcileActiveMissionFacts, resolveActiveMissionQuestIds } from "./active-reconciliation"

// Character queries
export { getCharacterStoryQuestIds, getCharacterIdFromMission } from "./character-queries"

// Awake summary (for /load response)
export { computeAwakeSummary } from "./compute-awake-summary"
export type { AwakeMissionComputedProgress, AwakeMissionInfo, AwakeMissionSettlementResult } from "./awake-settlement"
export { getAwakeBattleMissionIds, settleAwakeMissionCandidates, settleAwakeMissionRewards } from "./awake-settlement"
export type { AwakeUnlockProgress, AwakeUnlockReconciliationResult } from "./awake-unlock"
export { reconcileAwakeUnlocks, reconcileAwakeUnlocksFromProgress } from "./awake-unlock"
export type { CharacterAwakeBaseReadiness, CharacterAwakeEligibilityResolver } from "./awake-eligibility"
export { createCharacterAwakeEligibilityResolver, getCharacterAwakeBaseReadiness, isCharacterAwakeBaseReady, isCharacterAwakeNewUnlockEligible } from "./awake-eligibility"
export { reconcileAwakeUnlockCharacterList } from "./awake-unlock-response"

// Degree helpers
export { getTargetDegree } from "./computer-degree"
export { getDegreeMissionIdsForConditionTypes } from "./degree-candidates"

// Filter (active mission ID filtering, C8601 prevention)
export { isActiveMissionId, filterToActiveMissions } from "./filter"
