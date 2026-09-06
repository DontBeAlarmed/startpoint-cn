import { getCharacterFacts } from "./character-content"
import { getCharacterGrowthContent } from "./character-growth-content"
import { getMissionCatalog } from "./mission/mission-catalog"

export interface PlayerProfileStats {
    readonly maxOpenedManaBoardSecondCount: number
    readonly maxOwnedCharacterCount: number
    readonly maxOwnedDegreeCount: number
    readonly openedManaBoardSecondCount: number
}

export function getPlayerProfileStatsSync(
    playerCharacters: Readonly<Record<string, { readonly manaBoardIndex: number }>>,
): PlayerProfileStats {
    return Object.freeze({
        maxOpenedManaBoardSecondCount: getCharacterGrowthContent().getSecondBoardCharacterCount(),
        maxOwnedCharacterCount: getCharacterFacts().getCharacterCount(),
        maxOwnedDegreeCount: getMissionCatalog().getMissionIds(5).length,
        openedManaBoardSecondCount: Object.values(playerCharacters)
            .filter(character => character.manaBoardIndex >= 2).length,
    })
}
