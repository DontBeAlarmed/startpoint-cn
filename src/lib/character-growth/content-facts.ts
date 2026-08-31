import {
    getCharacterDataSync,
    getCharacterManaBoardCountSync,
    getCharacterManaNodesSync,
} from "../assets"
import { growthError } from "./errors"
import type { CharacterGrowthContentFacts } from "./model"

export function getCharacterGrowthContentFactsSync(
    characterId: number,
): CharacterGrowthContentFacts {
    const character = getCharacterDataSync(characterId)
    if (character === null || !Number.isSafeInteger(character.rarity) || character.rarity <= 0) {
        throw growthError("CONTENT_INVALID", `character ${characterId} content is unavailable.`)
    }

    const boardCount = getCharacterManaBoardCountSync(characterId)
    const boardNodeIds = new Map<number, ReadonlySet<number>>()
    for (let boardIndex = 1; boardIndex <= boardCount; boardIndex++) {
        const nodes = getCharacterManaNodesSync(characterId, boardIndex) ?? {}
        boardNodeIds.set(boardIndex, new Set(Object.keys(nodes).map(Number)))
    }

    return {
        boardCount,
        boardNodeIds,
        secondBoardAvailable: boardCount >= 2,
    }
}

