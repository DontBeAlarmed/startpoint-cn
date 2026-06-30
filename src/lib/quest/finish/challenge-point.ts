import { QuestCategory } from "../../types"

export function handleDailyChallengePoint(params: {
    questCategory: QuestCategory
    eventId: number | undefined
    playerId: number
    challengePointMap: Record<string, number>
    getEntries: (playerId: number) => Array<{ id: number; point: number; campaignList: Array<{ campaignId: number; additionalPoint: number }> }>
    updatePoint: (playerId: number, id: number, point: number) => void
}): Object[] | null {
    const { questCategory, eventId, playerId, challengePointMap, getEntries, updatePoint } = params

    if (questCategory !== QuestCategory.EXPERT_SINGLE_EVENT || !eventId) return null

    const cpKey = `expert_${eventId}`
    const challengePointId = challengePointMap[cpKey]
    if (!challengePointId) return null

    const entries = getEntries(playerId)
    const entry = entries.find(e => e.id === challengePointId)
    if (entry && entry.point > 0) {
        updatePoint(playerId, challengePointId, entry.point - 1)
    }

    return entries.map(e => ({
        "id": e.id,
        "point": e.id === challengePointId ? Math.max(0, e.point - 1) : e.point,
        "campaign_list": e.campaignList.map(c => ({
            "campaign_id": c.campaignId,
            "additional_point": c.additionalPoint
        }))
    }))
}
