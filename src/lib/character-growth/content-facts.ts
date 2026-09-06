import { getCharacterFacts } from "../character-content"
import { getCharacterGrowthContent } from "../character-growth-content"
import { growthError } from "./errors"
import type { CharacterGrowthContentFacts } from "./model"

export function getCharacterGrowthContentFactsSync(
    characterId: number,
): CharacterGrowthContentFacts {
    const character = getCharacterFacts().get(characterId)
    if (character === null || !Number.isSafeInteger(character.rarity) || character.rarity <= 0) {
        throw growthError("CONTENT_INVALID", `character ${characterId} content is unavailable.`)
    }

    const growthContent = getCharacterGrowthContent()
    const boardCount = growthContent.getManaBoardCount(characterId)
    const boardNodeIds = new Map<number, ReadonlySet<number>>()
    for (let boardIndex = 1; boardIndex <= boardCount; boardIndex++) {
        const nodes = growthContent.getManaBoardNodes(characterId, boardIndex)
        if (nodes === null) {
            throw growthError(
                "CONTENT_INVALID",
                `character ${characterId} board ${boardIndex} content is unavailable.`,
            )
        }
        boardNodeIds.set(boardIndex, new Set(Object.keys(nodes).map(Number)))
    }

    return {
        rarity: character.rarity,
        boardCount,
        boardNodeIds,
        secondBoardAvailable: boardCount >= 2,
    }
}
