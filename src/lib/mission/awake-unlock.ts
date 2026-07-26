import { deletePlayerCharacterAwakeUnlocksSync, getPlayerCharacterAwakeUnlocksSync, upsertPlayerCharacterAwakeUnlockSync } from "../../data/domains/character_awake"
import type { CharacterAwakeUnlockMap } from "../../data/domains/character_awake"
import { getPlayerCategoryMissionsSync } from "../../data/domains/mission"
import { getDb } from "../../data/db"
import { getCharacterIdFromMission } from "./character-queries"
import { getComputer } from "./registry"
import { getAwakeMissionRewardStageDefinition } from "./rewards"
import { getCompletedStageNumbers, getMissionIdsByCategory } from "./stages"
import { createCharacterAwakeEligibilityResolver } from "./awake-eligibility"
import type { CharacterAwakeEligibilityResolver } from "./awake-eligibility"
import { buildAwakeContext } from "./computer-awake"

export interface AwakeUnlockReconciliationResult {
    all: CharacterAwakeUnlockMap
    changed: CharacterAwakeUnlockMap
    removed: CharacterAwakeUnlockMap
}

export interface AwakeUnlockProgress {
    missionId: number
    progress: number
}

export function reconcileAwakeUnlocksFromProgress(
    playerId: number,
    progressList: AwakeUnlockProgress[],
    resolver: CharacterAwakeEligibilityResolver = createCharacterAwakeEligibilityResolver(playerId),
): AwakeUnlockReconciliationResult {
    const changed: CharacterAwakeUnlockMap = new Map()
    const removed: CharacterAwakeUnlockMap = new Map()

    getDb().transaction(() => {
        for (const [characterId, levels] of getPlayerCharacterAwakeUnlocksSync(playerId)) {
            const numericCharacterId = Number(characterId)
            if (resolver.getBaseReadiness(numericCharacterId) !== "not-ready") continue
            if (resolver.hasPositiveManaNodeAwakeLevel(numericCharacterId)) continue
            if (deletePlayerCharacterAwakeUnlocksSync(playerId, numericCharacterId)) {
                removed.set(characterId, { ...levels })
            }
        }

        for (const entry of progressList) {
            const characterId = getCharacterIdFromMission(entry.missionId)
            if (!resolver.isNewUnlockEligible(Number(characterId), entry.missionId)) continue

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
        removed,
    }
}

export function reconcileAwakeUnlocks(
    playerId: number,
    candidateCharacterIds?: number[],
    resolver: CharacterAwakeEligibilityResolver = createCharacterAwakeEligibilityResolver(playerId),
): AwakeUnlockReconciliationResult {
    if (candidateCharacterIds?.length === 0) {
        return reconcileAwakeUnlocksFromProgress(playerId, [], resolver)
    }

    const ownedCharacters = resolver.characters
    const persistedMissions = getPlayerCategoryMissionsSync(playerId, 9)
    const candidateIds = candidateCharacterIds ? new Set(candidateCharacterIds.map(String)) : null
    const computer = getComputer(9)
    const context = buildAwakeContext(playerId, ownedCharacters)
    const progressList: AwakeUnlockProgress[] = []

    for (const missionId of getMissionIdsByCategory(9)) {
        const characterId = getCharacterIdFromMission(missionId)
        if (!ownedCharacters[characterId] || (candidateIds && !candidateIds.has(characterId))) continue
        if (!resolver.isNewUnlockEligible(Number(characterId), missionId)) continue

        const dbProgress = persistedMissions[String(missionId)]?.progress ?? 0
        progressList.push({
            missionId,
            progress: computer.compute(missionId, context, dbProgress),
        })
    }

    return reconcileAwakeUnlocksFromProgress(playerId, progressList, resolver)
}
