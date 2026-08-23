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

export interface CharacterAwakeEligibilitySnapshot {
    readonly characters: Record<string, PlayerCharacter>
    readonly manaNodes: Record<string, number[]>
    readonly manaNodeAwakeLevels: Record<string, Record<number, number>>
    readonly evaluationTime: Date
}

function clonePlayerCharacter(character: PlayerCharacter): PlayerCharacter {
    return {
        ...character,
        joinTime: new Date(character.joinTime.getTime()),
        updateTime: new Date(character.updateTime.getTime()),
        bondTokenList: character.bondTokenList.map(entry => ({ ...entry })),
        ...(character.exBoost === undefined ? {} : {
            exBoost: {
                ...character.exBoost,
                abilityIdList: [...character.exBoost.abilityIdList],
            },
        }),
        ...(character.illustrationSettings === undefined ? {} : {
            illustrationSettings: [...character.illustrationSettings],
        }),
    }
}

function cloneCharacters(
    characters: Record<string, PlayerCharacter>,
): Record<string, PlayerCharacter> {
    return Object.fromEntries(Object.entries(characters).map(([characterId, character]) => (
        [characterId, clonePlayerCharacter(character)]
    )))
}

function cloneManaNodes(manaNodes: Record<string, number[]>): Record<string, number[]> {
    return Object.fromEntries(Object.entries(manaNodes).map(([characterId, nodeIds]) => (
        [characterId, [...nodeIds]]
    )))
}

function cloneManaNodeAwakeLevels(
    awakeLevels: Record<string, Record<number, number>>,
): Record<string, Record<number, number>> {
    return Object.fromEntries(Object.entries(awakeLevels).map(([characterId, levels]) => (
        [characterId, { ...levels }]
    )))
}

export function createCharacterAwakeEligibilityResolverFromSnapshot(
    snapshot: CharacterAwakeEligibilitySnapshot,
): CharacterAwakeEligibilityResolver {
    const evaluationTimeMs = snapshot.evaluationTime.getTime()
    if (!Number.isFinite(evaluationTimeMs)) {
        throw new TypeError("Awake eligibility evaluationTime must be a valid Date")
    }
    const characters = cloneCharacters(snapshot.characters)
    const manaNodes = cloneManaNodes(snapshot.manaNodes)
    const manaNodeAwakeLevels = cloneManaNodeAwakeLevels(snapshot.manaNodeAwakeLevels)
    const evaluationTime = new Date(evaluationTimeMs)
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

    return Object.freeze({
        get characters() {
            return cloneCharacters(characters)
        },
        get manaNodes() {
            return cloneManaNodes(manaNodes)
        },
        get manaNodeAwakeLevels() {
            return cloneManaNodeAwakeLevels(manaNodeAwakeLevels)
        },
        get evaluationTime() {
            return new Date(evaluationTimeMs)
        },
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
    })
}

export function createCharacterAwakeEligibilityResolver(
    playerId: number,
    evaluationTime: Date = getServerDate(),
): CharacterAwakeEligibilityResolver {
    return createCharacterAwakeEligibilityResolverFromSnapshot({
        characters: getPlayerCharactersSync(playerId),
        manaNodes: getPlayerCharactersManaNodesSync(playerId),
        manaNodeAwakeLevels: getPlayerCharactersManaNodeAwakeLevelsSync(playerId),
        evaluationTime,
    })
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
