import { clientSerializeDate } from "../data/utils/date";
import { getDb } from "../data/db";
import { getPlayerCharacterSync, insertPlayerCharacterSync, updatePlayerCharacterSync } from "../data/domains/character"
import { givePlayerItemSync, givePlayerItemWithinTransactionSync } from "../data/domains/item"
import { getCharacterDataSync } from "./assets";
import { getRealNow } from "../runtime/time/game-time";
import { GivePlayerCharacterResult } from "./types";
import { recordHundredCharactersMilestoneSync } from "./player-history-milestones";
import {
    grantCharacterExp,
    grantCharacterExpWithinTransactionSync,
} from "./character-growth/commands/grant-character-exp"
import { grantCharacterStackWithinTransactionSync } from "./character-growth/commands/grant-character-stack"
export { characterExpCaps } from "./character-growth/exp-caps";

/**
 * Rewards a player a character.
 * 
 * @param playerId The ID of the player.
 * @param characterId The ID of the character to give.
 * @returns An items list, indicating what, if any, items were given to the player.
 */
function givePlayerCharacterWithItemWriterSync(
    playerId: number,
    characterId: number,
    giveItem: typeof givePlayerItemSync,
): GivePlayerCharacterResult | null {

    // get the character's asset data
    const assetData = getCharacterDataSync(characterId)
    if (assetData === null) return null;

    // get the current character data
    const playerCharacter = getPlayerCharacterSync(playerId, characterId)

    if (playerCharacter === null) {
        const bondTokenList = [
            {
                manaBoardIndex: 1,
                status: 0
            }
        ]

        // add the second bond token list item
        // if the character has more than 1 mana board
        if (assetData.skill_count > 3) {
            bondTokenList.push({
                manaBoardIndex: 2,
                status: 0
            })
        }

        // give the player the character
        const joinTime = getRealNow()
        insertPlayerCharacterSync(playerId, characterId, {
            entryCount: 1,
            evolutionLevel: 0,
            overLimitStep: 0,
            protection: false,
            joinTime: joinTime,
            updateTime: joinTime,
            exp: 0,
            stack: 0,
            manaBoardIndex: 1,
            bondTokenList: bondTokenList
        })
        recordHundredCharactersMilestoneSync(playerId, joinTime)
        
        const serializedDate = clientSerializeDate(joinTime)
        return {
            isNew: true,
            character: {
                "viewer_id": 0,
                "character_id": characterId,
                "entry_count": 1,
                "exp": 0,
                "exp_total": 0,
                "bond_token_list": bondTokenList.map(bondToken => {
                    return {
                        "mana_board_index": bondToken.manaBoardIndex,
                        "status": bondToken.status
                    }
                }),
                "mana_board_index": 1,
                "create_time": serializedDate,
                "update_time": serializedDate,
                "join_time": serializedDate,
            }
        }
    } else {
        // Duplicate ownership is a Growth mutation. The character domain keeps
        // responsibility for creating first-time ownership only.
        const grant = () => grantCharacterStackWithinTransactionSync(
            { playerId, characterId },
            giveItem as typeof givePlayerItemWithinTransactionSync,
            playerCharacter,
        )
        return getDb().inTransaction ? grant() : getDb().transaction(grant)()
    }
}

export function givePlayerCharacterSync(
    playerId: number,
    characterId: number,
): GivePlayerCharacterResult | null {
    return givePlayerCharacterWithItemWriterSync(playerId, characterId, givePlayerItemSync)
}

export function givePlayerCharacterWithinTransactionSync(
    playerId: number,
    characterId: number,
    giveItem: typeof givePlayerItemWithinTransactionSync = givePlayerItemWithinTransactionSync,
): GivePlayerCharacterResult | null {
    if (!getDb().inTransaction) {
        throw new Error("givePlayerCharacterWithinTransactionSync requires an active caller transaction")
    }
    return givePlayerCharacterWithItemWriterSync(
        playerId,
        characterId,
        giveItem,
    )
}

/**
 * Adds a given amount of exp to a list of characters.
 * 
 * @param playerId The ID of the player who owns the characters.
 * @param characterIds A list of character IDs to add exp to.
 * @param expAmount The amount of exp to add.
 * @returns A RewardPlayerCharacterExpResult, detailing how much exp was added.
 */
/**
 * Compatibility adapter for callers outside a settlement owner. All EXP
 * calculations and writes belong to the Growth command implementation.
 */
export function givePlayerCharactersExpSync(
    playerId: number,
    characterIds: number[],
    expAmount: number,
    ignoreUpdate: boolean,
    knownExpPool?: number,
    evaluationTime?: Date,
): ReturnType<typeof grantCharacterExp> {
    const command = {
        playerId,
        characterIds,
        amount: expAmount,
        ignoreUpdate,
        knownExpPool,
        evaluationTime,
    }
    return getDb().inTransaction
        ? grantCharacterExpWithinTransactionSync(command)
        : grantCharacterExp(command)
}

/**
 * Gets the current evolution image levels for an array of character ids for a player.
 * 
 * @param playerId The ID of the player.
 * @param characterIds The array of character ids.
 * @returns 
 */
export function getCharactersEvolutionImgLevels(
    playerId: number,
    characterIds: (number | null)[]
): (number | null)[] {
    const evolutionImgLevels: (number | null)[] = []
    for (const id of characterIds) {
        if (id !== null) {
            const character = getPlayerCharacterSync(playerId, id)
            const illustrationSettings = character?.illustrationSettings ?? [null]
            const evolutionLevel = character?.evolutionLevel ?? 0
            evolutionImgLevels.push(illustrationSettings[0] === null ? evolutionLevel : illustrationSettings[0])
        } else {
            evolutionImgLevels.push(null)
        }
    }
    return evolutionImgLevels
}
