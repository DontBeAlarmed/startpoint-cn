import bundledCharacters from "../../assets/character.json"
import bundledDegreeRewards from "../../assets/mission_degree_reward.json"
import bundledManaBoards from "../../assets/mana_board.json"

import { getRuntimeContentTableSync } from "../content/runtime/table-access"

type Table = Record<string, unknown>

export interface PlayerProfileStats {
    readonly maxOpenedManaBoardSecondCount: number
    readonly maxOwnedCharacterCount: number
    readonly maxOwnedDegreeCount: number
    readonly openedManaBoardSecondCount: number
}

export function getPlayerProfileStatsSync(
    playerCharacters: Readonly<Record<string, { readonly manaBoardIndex: number }>>,
): PlayerProfileStats {
    const characters = getRuntimeContentTableSync(
        "character.json",
        bundledCharacters as Table,
    ) as Table
    const manaBoards = getRuntimeContentTableSync(
        "mana_board.json",
        bundledManaBoards as Table,
    ) as Record<string, Record<string, unknown>>
    const degreeRewards = getRuntimeContentTableSync(
        "mission_degree_reward.json",
        bundledDegreeRewards as Table,
    ) as Table
    return Object.freeze({
        maxOpenedManaBoardSecondCount: Object.values(manaBoards)
            .filter(board => board?.["2"] !== undefined).length,
        maxOwnedCharacterCount: Object.keys(characters).length,
        maxOwnedDegreeCount: Object.keys(degreeRewards).length,
        openedManaBoardSecondCount: Object.values(playerCharacters)
            .filter(character => character.manaBoardIndex >= 2).length,
    })
}
