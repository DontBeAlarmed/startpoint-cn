import { QuestCategory } from "../../types"
import { getDailyChallengePointId } from "../daily-challenge"

export function handleDailyChallengePoint(params: {
    questCategory: QuestCategory
    questId: number
    eventId: number | undefined
    playerId: number
    challengePointMap: Record<string, number>
    refreshPoints: (playerId: number) => void
    getEntries: (playerId: number) => Array<{ id: number; point: number; campaignList: Array<{ campaignId: number; additionalPoint: number }> }>
    updatePoint: (playerId: number, id: number, point: number) => void
}): Object[] | null {
    const { questCategory, questId, eventId, playerId, challengePointMap, getEntries, updatePoint } = params

    const challengePointId = getDailyChallengePointId(
        questCategory,
        questId,
        eventId,
        challengePointMap,
    )
    if (!challengePointId) return null

    params.refreshPoints(playerId)
    const entries = getEntries(playerId)
    const entry = entries.find(e => e.id === challengePointId)
    if (entry === undefined || entry.point <= 0) return entries.map(e => ({
        "id": e.id,
        "point": e.point,
        "campaign_list": e.campaignList.map(c => ({
            "campaign_id": c.campaignId,
            "additional_point": c.additionalPoint
        }))
    }))
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
