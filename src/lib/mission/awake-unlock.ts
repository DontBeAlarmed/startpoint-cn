import { getPlayerCharacterAwakeUnlocksSync, upsertPlayerCharacterAwakeUnlockSync } from "../../data/domains/character_awake"
import type { CharacterAwakeUnlockMap } from "../../data/domains/character_awake"
import { getPlayerCharactersSync } from "../../data/domains/character"
import { getPlayerCategoryMissionsSync } from "../../data/domains/mission"
import { getDb } from "../../data/db"
import { getCharacterIdFromMission } from "./character-queries"
import { getComputer } from "./registry"
import { getAwakeMissionRewardStageDefinition } from "./rewards"
import { getCompletedStageNumbers, getMissionIdsByCategory } from "./stages"
import { getServerDate } from "../../utils"

export interface AwakeUnlockReconciliationResult {
    all: CharacterAwakeUnlockMap
    changed: CharacterAwakeUnlockMap
}

export interface AwakeUnlockProgress {
    missionId: number
    progress: number
}

export function reconcileAwakeUnlocksFromProgress(
    playerId: number,
    progressList: AwakeUnlockProgress[]
): AwakeUnlockReconciliationResult {
    const changed: CharacterAwakeUnlockMap = new Map()

    getDb().transaction(() => {
        for (const entry of progressList) {
            const characterId = getCharacterIdFromMission(entry.missionId)
            for (const stage of getCompletedStageNumbers(9, entry.missionId, entry.progress)) {
                const specialReward = getAwakeMissionRewardStageDefinition(entry.missionId, stage)?.specialReward
                if (!specialReward || String(specialReward.characterId) !== characterId) continue
                if (!upsertPlayerCharacterAwakeUnlockSync(
                    playerId,
                    specialReward.characterId,
                    specialReward.boardIndex,
                    specialReward.awakeLevel
                )) continue

                const levels = changed.get(characterId) ?? {}
                levels[specialReward.boardIndex] = Math.max(
                    levels[specialReward.boardIndex] ?? 0,
                    specialReward.awakeLevel
                )
                changed.set(characterId, levels)
            }
        }
    })()

    return {
        all: getPlayerCharacterAwakeUnlocksSync(playerId),
        changed,
    }
}

export function reconcileAwakeUnlocks(
    playerId: number,
    candidateCharacterIds?: number[]
): AwakeUnlockReconciliationResult {
    if (candidateCharacterIds?.length === 0) {
        return reconcileAwakeUnlocksFromProgress(playerId, [])
    }

    const ownedCharacters = getPlayerCharactersSync(playerId)
    const persistedMissions = getPlayerCategoryMissionsSync(playerId, 9)
    const candidateIds = candidateCharacterIds ? new Set(candidateCharacterIds.map(String)) : null
    const computer = getComputer(9)
    const context = computer.buildContext(playerId, 9, getServerDate())
    const progressList: AwakeUnlockProgress[] = []

    for (const missionId of getMissionIdsByCategory(9)) {
        const characterId = getCharacterIdFromMission(missionId)
        if (!ownedCharacters[characterId] || (candidateIds && !candidateIds.has(characterId))) continue

        const dbProgress = persistedMissions[String(missionId)]?.progress ?? 0
        progressList.push({
            missionId,
            progress: computer.compute(missionId, context, dbProgress),
        })
    }

    return reconcileAwakeUnlocksFromProgress(playerId, progressList)
}
