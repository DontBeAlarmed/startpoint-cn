// lib/mission barrel — unified mission system

// Types
export type { MissionComputer, CategoryContext, ComputerRegistry, PlayerQuestProgressEntry } from "./types"

// Registry
export { getComputer } from "./registry"

// Stages
export { getMissionIdsByCategory, getCurrentStage, getCompletedStageNumbers, getMissionStageIds } from "./stages"

// Rewards
export type { ActiveMissionReward } from "./rewards"
export { getActiveMissionRewards, getAwakeMissionRewards, getEventMissionRewards } from "./rewards"

// Patterns (for update_mission_progress)
export type { PatternMatch } from "./patterns"
export { getMissionsByPattern, getMissionPattern, isComputablePattern } from "./patterns"

// Character queries
export { getCharacterStoryQuestIds, getCharacterIdFromMission } from "./character-queries"

// Awake summary (for /load response)
export { computeAwakeSummary } from "./compute-awake-summary"

// Degree helpers
export { getTargetDegree } from "./computer-degree"

// Filter (active mission ID filtering, C8601 prevention)
export { isActiveMissionId, filterToActiveMissions } from "./filter"
