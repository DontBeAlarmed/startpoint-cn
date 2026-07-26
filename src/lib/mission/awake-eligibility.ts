import {
    getPlayerCharactersManaNodeAwakeLevelsSync,
    getPlayerCharactersManaNodesSync,
    getPlayerCharactersSync,
} from "../../data/domains/character"
import type { PlayerCharacter } from "../../data/types"
import { getServerDate } from "../../utils"
import { getCharacterDataSync, getCharacterManaNodesSync } from "../assets"
import { characterExpCaps } from "../character"
import { getCharacterIdFromMission } from "./character-queries"
import { isMissionEnabledAt } from "./patterns"

export type CharacterAwakeBaseReadiness = "ready" | "not-ready" | "unknown"

export interface CharacterAwakeEligibilityResolver {
    readonly characters: Record<string, PlayerCharacter>
    readonly manaNodes: Record<string, number[]>
    readonly manaNodeAwakeLevels: Record<string, Record<number, number>>
    readonly evaluationTime: Date
    getBaseReadiness(characterId: number): CharacterAwakeBaseReadiness
    hasPositiveManaNodeAwakeLevel(characterId: number): boolean
    isNewUnlockEligible(characterId: number, missionId: number): boolean
}

export function createCharacterAwakeEligibilityResolver(
    playerId: number,
    evaluationTime: Date = getServerDate(),
): CharacterAwakeEligibilityResolver {
    const characters = getPlayerCharactersSync(playerId)
    const manaNodes = getPlayerCharactersManaNodesSync(playerId)
    const manaNodeAwakeLevels = getPlayerCharactersManaNodeAwakeLevelsSync(playerId)
    const readinessCache = new Map<number, CharacterAwakeBaseReadiness>()

    function getBaseReadiness(characterId: number): CharacterAwakeBaseReadiness {
        const cached = readinessCache.get(characterId)
        if (cached !== undefined) return cached

        const asset = getCharacterDataSync(characterId)
        const boardOne = getCharacterManaNodesSync(characterId, 1)
        const boardOneNodeIds = boardOne ? Object.keys(boardOne) : []
        let readiness: CharacterAwakeBaseReadiness

        if (!asset || boardOneNodeIds.length === 0) {
            readiness = "unknown"
        } else {
            const baseExpCap = characterExpCaps[asset.rarity]?.[0]
            const character = characters[String(characterId)]
            if (baseExpCap === undefined) {
                readiness = "unknown"
            } else if (!character || character.exp < baseExpCap) {
                readiness = "not-ready"
            } else {
                const learnedNodeIds = new Set(manaNodes[String(characterId)] ?? [])
                readiness = boardOneNodeIds.every(nodeId => learnedNodeIds.has(Number(nodeId)))
                    ? "ready"
                    : "not-ready"
            }
        }

        readinessCache.set(characterId, readiness)
        return readiness
    }

    return {
        characters,
        manaNodes,
        manaNodeAwakeLevels,
        evaluationTime,
        getBaseReadiness,
        hasPositiveManaNodeAwakeLevel(characterId: number): boolean {
            return Object.values(manaNodeAwakeLevels[String(characterId)] ?? {})
                .some(awakeLevel => awakeLevel > 0)
        },
        isNewUnlockEligible(characterId: number, missionId: number): boolean {
            return getCharacterIdFromMission(missionId) === String(characterId)
                && isMissionEnabledAt(9, missionId, evaluationTime)
                && getBaseReadiness(characterId) === "ready"
        },
    }
}

export function getCharacterAwakeBaseReadiness(
    playerId: number,
    characterId: number,
): CharacterAwakeBaseReadiness {
    return createCharacterAwakeEligibilityResolver(playerId).getBaseReadiness(characterId)
}

export function isCharacterAwakeBaseReady(
    playerId: number,
    characterId: number,
): boolean {
    return getCharacterAwakeBaseReadiness(playerId, characterId) === "ready"
}

export function isCharacterAwakeNewUnlockEligible(
    playerId: number,
    characterId: number,
    missionId: number,
    at: Date = getServerDate(),
): boolean {
    return createCharacterAwakeEligibilityResolver(playerId, at)
        .isNewUnlockEligible(characterId, missionId)
}
