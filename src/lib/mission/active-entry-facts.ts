import { incrementActiveMissionPracticeQuestChallengeCountSync } from "../../data/domains/active_mission_counters"
import { QuestCategory } from "../types"

export function recordActiveMissionQuestChallengeFactSync(
    playerId: number,
    questCategory: number,
): void {
    if (questCategory !== QuestCategory.PRACTICE) return
    incrementActiveMissionPracticeQuestChallengeCountSync(playerId)
}
