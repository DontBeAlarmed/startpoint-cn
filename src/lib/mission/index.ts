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

// Patterns (for update_mission_progress)
export type { PatternMatch } from "./patterns"
export { getMissionsByPattern, getMissionDefinition, getMissionPattern, isComputablePattern, isMissionEnabledAt } from "./patterns"

export type { MissionRewardClaimValidation, ValidatedMissionRewardClaim } from "./claims"
export { validateMissionRewardClaims } from "./claims"

// Character queries
export { getCharacterStoryQuestIds, getCharacterIdFromMission } from "./character-queries"

// Awake summary (for /load response)
export { computeAwakeSummary } from "./compute-awake-summary"
export type { AwakeMissionComputedProgress, AwakeMissionInfo, AwakeMissionSettlementResult } from "./awake-settlement"
export { settleAwakeMissionRewards } from "./awake-settlement"

// Degree helpers
export { getTargetDegree } from "./computer-degree"

// Filter (active mission ID filtering, C8601 prevention)
export { isActiveMissionId, filterToActiveMissions } from "./filter"
