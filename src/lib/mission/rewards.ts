// Mission reward parsers — from CDN reward tables

import activeRewards from "../../../assets/mission_active_reward.json"
import eventRewards from "../../../assets/mission_event_reward.json"
import charAwakeRewards from "../../../assets/mission_char_awake_reward.json"

export interface ActiveMissionReward {
    kind: number
    amount: number
    itemId?: number
    characterId?: number
    equipmentId?: number
}

export function getActiveMissionRewards(missionId: number, stage: number): ActiveMissionReward[] {
    const mission = (activeRewards as Record<string, Record<string, any[]>>)[String(missionId)]
    if (!mission) return []
    const stageData = mission[String(stage)]
    if (!stageData || !stageData[0]) return []
    const row = stageData[0]

    const result: ActiveMissionReward[] = []
    for (let slot = 0; slot < 4; slot++) {
        const base = 7 + slot * 6
        const kind = parseInt(row[base]) || 0
        if (kind === 0) continue
        const amount = parseInt(row[base + 1]) || 0
        if (amount === 0) continue

        const itemId = row[base + 2] ? parseInt(row[base + 2]) : undefined
        const charId = row[base + 3] ? parseInt(row[base + 3]) : undefined
        const equipId = row[base + 4] ? parseInt(row[base + 4]) : undefined

        // Skip item/equipment rewards with missing IDs (prevents SQL NOT NULL crash)
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

export function getAwakeMissionRewards(missionId: number, stage: number): ActiveMissionReward[] {
    const mission = (charAwakeRewards as Record<string, Record<string, any[]>>)[String(missionId)]
    if (!mission) return []
    const stageData = mission[String(stage)]
    if (!stageData || !stageData[0]) return []
    const row = stageData[0]

    const result: ActiveMissionReward[] = []
    const base = 9
    const kind = parseInt(row[base]) || 0
    if (kind === 0) return []
    const amount = parseInt(row[base + 1]) || 0
    if (amount === 0) return []

    const itemId = row[base + 2] ? parseInt(row[base + 2]) : undefined

    // Skip item/equipment rewards with missing IDs (prevents SQL NOT NULL crash)
    if ((kind === 1 || kind === 2) && !itemId) return []

    const reward: ActiveMissionReward = { kind, amount }
    if (itemId) reward.itemId = itemId
    result.push(reward)
    return result
}

export function getEventMissionRewards(missionId: number, stage: number): ActiveMissionReward[] {
    const mission = (eventRewards as Record<string, Record<string, any[]>>)[String(missionId)]
    if (!mission) return []
    const stageData = mission[String(stage)]
    if (!stageData || !stageData[0]) return []
    const row = stageData[0]

    const result: ActiveMissionReward[] = []
    // Event rewards use base=5 (single slot, kind=col[5], amount=col[6], item=col[7])
    const base = 5
    const kind = parseInt(row[base]) || 0
    if (kind === 0) return []
    const amount = parseInt(row[base + 1]) || 0
    if (amount === 0) return []

    const itemId = row[base + 2] ? parseInt(row[base + 2]) : undefined

    // Skip item/equipment rewards with missing IDs (prevents SQL NOT NULL crash)
    if ((kind === 1 || kind === 2) && !itemId) return []

    const reward: ActiveMissionReward = { kind, amount }
    if (itemId) reward.itemId = itemId
    result.push(reward)
    return result
}
