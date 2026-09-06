import { getCharacterFacts } from "./character-content"
import { getCharacterGrowthContent } from "./character-growth-content"
import type { ManaBoard2OpenCondition } from "./character-growth-content"
import { getServerDate } from "../utils"

export type { ManaBoard2OpenCondition } from "./character-growth-content"

function getOpenConditions(): ReadonlyMap<number, ManaBoard2OpenCondition> {
    return getCharacterGrowthContent().getSecondBoardOpenConditions()
}

export function isSecondManaBoardAvailable(
    characterId: number,
    rarity: number,
    evaluationTime: Date,
    conditions: ReadonlyMap<number, ManaBoard2OpenCondition> = getOpenConditions(),
): boolean {
    if (!Number.isSafeInteger(characterId) || characterId <= 0 || rarity <= 2) return false
    const condition = conditions.get(characterId)
    if (!condition || !Number.isFinite(evaluationTime.getTime())) return false
    const timestamp = evaluationTime.getTime()
    return condition.startTime.getTime() <= timestamp && timestamp <= condition.endTime.getTime()
}

export function isCharacterSecondManaBoardAvailable(
    characterId: number,
    evaluationTime: Date = getServerDate(),
): boolean {
    const character = getCharacterFacts().get(characterId)
    return character !== null && isSecondManaBoardAvailable(
        characterId,
        character.rarity,
        evaluationTime,
    )
}

export function getVisibleManaBoardIndex(
    persistedIndex: number,
    characterId: number,
    rarity: number,
    evaluationTime: Date,
    conditions: ReadonlyMap<number, ManaBoard2OpenCondition> = getOpenConditions(),
): number {
    if (!Number.isSafeInteger(persistedIndex) || persistedIndex <= 1) return 1
    return isSecondManaBoardAvailable(characterId, rarity, evaluationTime, conditions) ? 2 : 1
}

export function getCharacterVisibleManaBoardIndex(
    persistedIndex: number,
    characterId: number,
    evaluationTime: Date = getServerDate(),
): number {
    const character = getCharacterFacts().get(characterId)
    if (character === null) return 1
    return getVisibleManaBoardIndex(
        persistedIndex,
        characterId,
        character.rarity,
        evaluationTime,
    )
}
