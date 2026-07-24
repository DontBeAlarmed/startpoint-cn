// Compute awake mission summary for /load response
// Returns active_mission_list (Array format for data.active_mission_list)

import { getPlayerCategoryMissionsSync } from "../../data/domains/mission"
import { getPlayerCharactersSync } from "../../data/domains/character"
import { getPlayerCharacterAwakeUnlocksSync } from "../../data/domains/character_awake"
import { getComputer } from "./registry"
import { getMissionIdsByCategory, getMissionStageIds } from "./stages"
import { getCharacterIdFromMission } from "./character-queries"
import type { CategoryContext } from "./types"
import { getServerDate } from "../../utils"

export interface AwakeMissionEntry {
    mission_id: number
    progress_value: number
    stages: { stage: number; received: boolean }[]
}

export interface AwakeSummary {
    activeMissionList: AwakeMissionEntry[]
    manaBoardAwakeMap: Map<string, Record<number, number>>
}

export function computeAwakeSummary(playerId: number): AwakeSummary {
    const activeMissions = getPlayerCategoryMissionsSync(playerId, 9)
    const playerChars = getPlayerCharactersSync(playerId)
    const awakeMissionIds = getMissionIdsByCategory(9)

    const charMissionMap = new Map<string, number[]>()
    for (const mid of awakeMissionIds) {
        const charId = getCharacterIdFromMission(mid)
        if (!charMissionMap.has(charId)) charMissionMap.set(charId, [])
        charMissionMap.get(charId)!.push(mid)
    }

    const computer = getComputer(9)
    const ctx = computer.buildContext(playerId, 9, getServerDate()) as CategoryContext

    const activeMissionList: AwakeMissionEntry[] = []
    const manaBoardAwakeMap = getPlayerCharacterAwakeUnlocksSync(playerId)

    for (const [charKId, missionIds] of charMissionMap) {
        if (!playerChars[charKId]) continue

        for (const missionId of missionIds) {
            const dbProgress = activeMissions[String(missionId)]?.progress ?? 0
            const progress = computer.compute(missionId, ctx, dbProgress)
            const allStageIds = getMissionStageIds(9, missionId)
            const persistedStages = activeMissions[String(missionId)]?.stages

            const stages = allStageIds.map(sid => ({
                stage: sid,
                received: !Array.isArray(persistedStages) && persistedStages?.[String(sid)] === true,
            }))

            activeMissionList.push({
                mission_id: missionId,
                progress_value: progress,
                stages,
            })
        }
    }

    return { activeMissionList, manaBoardAwakeMap }
}
