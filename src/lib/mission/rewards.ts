// Mission reward parsers — from CDN reward tables

import activeRewards from "../../../assets/mission_active_reward.json"
import regularRewards from "../../../assets/mission_regular_reward.json"
import dailyRewards from "../../../assets/mission_daily_reward.json"
import eventRewards from "../../../assets/mission_event_reward.json"
import degreeRewards from "../../../assets/mission_degree_reward.json"
import collectRewards from "../../../assets/mission_collect_item_reward.json"
import weeklyRewards from "../../../assets/mission_weekly_reward.json"
import charAwakeRewards from "../../../assets/mission_char_awake_reward.json"

export interface ActiveMissionReward {
    kind: number
    amount: number
    itemId?: number
    characterId?: number
    equipmentId?: number
}

function parseMissionRewardSlots(row: any[], firstKindIndex: number, slotCount: number): ActiveMissionReward[] {
    const result: ActiveMissionReward[] = []
    for (let slot = 0; slot < slotCount; slot++) {
        const base = firstKindIndex + slot * 6
        const kindRaw = row[base]
        if (kindRaw === undefined || kindRaw === "" || kindRaw === "(None)") continue
        const kind = parseInt(kindRaw)
        if (Number.isNaN(kind)) continue

        const amount = parseInt(row[base + 1]) || 0
        if (amount === 0 && kind !== 6) continue

        const itemId = row[base + 2] ? parseInt(row[base + 2]) : undefined
        const charId = row[base + 3] ? parseInt(row[base + 3]) : undefined
        const equipId = row[base + 4] ? parseInt(row[base + 4]) : undefined

        if (kind === 1 && !itemId) continue
        if (kind === 2 && !equipId) continue

        const reward: ActiveMissionReward = { kind, amount }
        if (itemId) reward.itemId = itemId
        if (charId) reward.characterId = charId
        if (equipId) reward.equipmentId = equipId
        result.push(reward)
    }
    return result
}

export function getActiveMissionRewards(missionId: number, stage: number): ActiveMissionReward[] {
    const mission = (activeRewards as Record<string, Record<string, any[]>>)[String(missionId)]
    if (!mission) return []
    const stageData = mission[String(stage)]
    if (!stageData || !stageData[0]) return []
    const row = stageData[0]

    return parseMissionRewardSlots(row, 7, 4)
}

export function getRegularMissionRewards(missionId: number, stage: number): ActiveMissionReward[] {
    const mission = (regularRewards as Record<string, Record<string, any[]>>)[String(missionId)]
    if (!mission) return []
    const stageData = mission[String(stage)]
    if (!stageData || !stageData[0]) return []
    return parseMissionRewardSlots(stageData[0], 5, 4)
}

export function getDailyMissionRewards(missionId: number, stage: number): ActiveMissionReward[] {
    const mission = (dailyRewards as Record<string, Record<string, any[]>>)[String(missionId)]
    if (!mission) return []
    const stageData = mission[String(stage)]
    if (!stageData || !stageData[0]) return []
    return parseMissionRewardSlots(stageData[0], 5, 4)
}

export function getAwakeMissionRewards(missionId: number, stage: number): ActiveMissionReward[] {
    const mission = (charAwakeRewards as Record<string, Record<string, any[]>>)[String(missionId)]
    if (!mission) return []
    const stageData = mission[String(stage)]
    if (!stageData || !stageData[0]) return []
    return parseMissionRewardSlots(stageData[0], 9, 4)
}

export function getEventMissionRewards(missionId: number, stage: number): ActiveMissionReward[] {
    const mission = (eventRewards as Record<string, Record<string, any[]>>)[String(missionId)]
    if (!mission) return []
    const stageData = mission[String(stage)]
    if (!stageData || !stageData[0]) return []
    const row = stageData[0]

    return parseMissionRewardSlots(row, 5, 4)
}

export function getDegreeMissionRewards(missionId: number, stage: number): ActiveMissionReward[] {
    const mission = (degreeRewards as Record<string, Record<string, any[]>>)[String(missionId)]
    if (!mission) return []
    const stageData = mission[String(stage)]
    if (!stageData || !stageData[0]) return []
    return parseMissionRewardSlots(stageData[0], 5, 4)
}

export function getCollectMissionRewards(missionId: number, stage: number): ActiveMissionReward[] {
    const mission = (collectRewards as Record<string, Record<string, any[]>>)[String(missionId)]
    if (!mission) return []
    const stageData = mission[String(stage)]
    if (!stageData || !stageData[0]) return []
    return parseMissionRewardSlots(stageData[0], 6, 4)
}

export function getWeeklyMissionRewards(missionId: number, stage: number): ActiveMissionReward[] {
    const mission = (weeklyRewards as Record<string, Record<string, any[]>>)[String(missionId)]
    if (!mission) return []
    const stageData = mission[String(stage)]
    if (!stageData || !stageData[0]) return []
    return parseMissionRewardSlots(stageData[0], 5, 4)
}
