// lib/mission barrel — unified mission system

// Types
export type { MissionComputer, CategoryContext, ComputerRegistry, PlayerQuestProgressEntry } from "./types"

// Registry
export { getComputer } from "./registry"

// Stages
export { getMissionIdsByCategory, getCurrentStage, getCompletedStageNumbers, getMissionStageIds } from "./stages"

// Rewards
export type { ActiveMissionReward, MissionRewardStageDefinition } from "./rewards"
export {
    getActiveMissionRewards,
    getAwakeMissionRewards,
    getCollectMissionRewards,
    getDailyMissionRewards,
    getDegreeMissionRewards,
    getEventMissionRewards,
    getMissionRewardStageDefinition,
    getRegularMissionRewards,
    getWeeklyMissionRewards,
} from "./rewards"

// Patterns (for update_mission_progress)
export type { PatternMatch } from "./patterns"
export { getMissionsByPattern, getMissionDefinition, getMissionPattern, isComputablePattern, isMissionEnabledAt } from "./patterns"

// Evaluator
export type { MissionEvaluationInput, MissionEvaluationResult } from "./evaluator"
export { evaluateMissionCounterProgress } from "./evaluator"

// Character queries
export { getCharacterStoryQuestIds, getCharacterIdFromMission } from "./character-queries"

// Awake summary (for /load response)
export { computeAwakeSummary } from "./compute-awake-summary"

// Degree helpers
export { getTargetDegree } from "./computer-degree"

// Filter (active mission ID filtering, C8601 prevention)
export { isActiveMissionId, filterToActiveMissions } from "./filter"

// Mission counters
export type {
    MissionCounterPeriod,
    MissionCounterQualifierValue,
    MissionCounterQuery,
    MissionCounterRow,
    MissionCounterScopeType,
} from "./counters"
export {
    addMissionCounterSync,
    getMissionCounterDeltaSync,
    getMissionCounterSnapshotValueSync,
    getMissionCounterValueSync,
    makeMissionCounterKey,
    normalizeMissionCounterQualifier,
    serializeMissionCounterQualifier,
    setMissionCounterMaxSync,
    snapshotAllMissionCountersSync,
} from "./counters"

// Mission events and battle dimension writer
export type { BattleFinishMissionEvent, BattleStatisticsSummary, MissionProgressEvent } from "./events"
export { collectPartyCharacterIds, summarizeBattleStatistics } from "./events"
export { recordBattleMissionDimensions, recordBattleMissionDimensionsSafe } from "./battle-dimensions"

// Active mission reward claims
export type { MissionRewardClaimValidation, ValidatedMissionRewardClaim } from "./claims"
export { validateMissionRewardClaims } from "./claims"
