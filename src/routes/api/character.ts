// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerCharacterSync, getPlayerCharactersSync, updatePlayerCharacterSync } from "../../data/domains/character"
import { getPlayerItemSync, updatePlayerItemSync } from "../../data/domains/item"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { generateDataHeaders } from "../../utils";
import { getCharacterDataSync } from "../../lib/assets";
import { characterExpCaps, givePlayerCharacterSync } from "../../lib/character";
import { clientSerializeDate } from "../../data/utils";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getDb } from "../../data/db";
import { reconcileAwakeUnlockCharacterList } from "../../lib/mission";
import { getMailArrivedSync } from "../../lib/mail-notification";
import { canClaimTownStoryCharacter } from "../../lib/story-join-character";

interface OverLimitBody {
    viewer_id: number
    character_id: number
    api_count: number
    use_stack: boolean
    item_id: number,
    over_limit_count: number
}

interface SetIllustrationSettingsBody {
    character_id: number,
    api_count: number,
    illustration_settings: number[],
    viewer_id: number
}

interface SetProtectionBody {
    character_ids: number[]
    protection: boolean
    viewer_id: number
    api_count: number
}

export const characterMaxOverLimits: Record<number, number> = {
    [1]: 12, // 1* max over limit count
    [2]: 10, // 2* max over limit count
    [3]: 8,  // 3* max over limit count 
    [4]: 6,  // 4* max over limit count
    [5]: 4,  // 5* max over limit count 
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/set_protection", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SetProtectionBody
        const viewerId = body.viewer_id
        const characterIds = body.character_ids

        if (!Number.isSafeInteger(viewerId) || viewerId <= 0
            || !Array.isArray(characterIds)
            || characterIds.some(id => !Number.isSafeInteger(id) || id <= 0)
            || typeof body.protection !== "boolean") {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid request body."
            })
        }

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null || getPlayerSync(playerId) === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        const uniqueCharacterIds = [...new Set(characterIds)]
        getDb().transaction(() => {
            for (const characterId of uniqueCharacterIds) {
                if (getPlayerCharacterSync(playerId, characterId) !== null) {
                    updatePlayerCharacterSync(playerId, characterId, {
                        protection: body.protection
                    })
                }
            }
        })()

        const characterList = uniqueCharacterIds.flatMap(characterId => {
            const character = getPlayerCharacterSync(playerId, characterId)
            if (!character) return []
            return [{
                "viewer_id": viewerId,
                "character_id": characterId,
                "entry_count": character.entryCount,
                "evolution_level": character.evolutionLevel,
                "evolution_img_level": character.evolutionLevel,
                "over_limit_step": character.overLimitStep,
                "protection": character.protection,
                "exp": character.exp,
                "stack": character.stack,
                "mana_board_index": character.manaBoardIndex,
                "bond_token_list": character.bondTokenList.map(entry => ({
                    "mana_board_index": entry.manaBoardIndex,
                    "status": entry.status,
                })),
                ...(character.exBoost ? {
                    "ex_boost": {
                        "status_id": character.exBoost.statusId,
                        "ability_id_list": character.exBoost.abilityIdList,
                    },
                } : {}),
                ...(character.illustrationSettings ? {
                    "illustration_settings": character.illustrationSettings,
                } : {}),
                "create_time": clientSerializeDate(character.joinTime),
                "update_time": clientSerializeDate(character.updateTime),
                "join_time": clientSerializeDate(character.joinTime),
            }]
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "character_list": characterList,
                "mail_arrived": getMailArrivedSync(playerId),
            }
        })
    })

    fastify.post("/set_illustration_settings", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SetIllustrationSettingsBody

        const viewerId = body.viewer_id
        const characterId = body.character_id
        const illustration_settings = body.illustration_settings
        if (!Number.isSafeInteger(viewerId)
            || viewerId <= 0
            || !Number.isSafeInteger(characterId)
            || characterId <= 0
            || !Array.isArray(illustration_settings)
            || illustration_settings.length !== 6
            || illustration_settings.some(value => !Number.isSafeInteger(value) || value < 0)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player id
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        if (getPlayerCharacterSync(playerId, characterId) === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Character not owned."
        })

        // update character
        updatePlayerCharacterSync(playerId, characterId, {
            illustrationSettings: illustration_settings
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {}
        }) 
    })

    fastify.post("/over_limit", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as OverLimitBody

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        const player = playerId !== null ? getPlayerSync(playerId) : null

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get character data
        const characterId = body.character_id
        const playerCharacterData = getPlayerCharacterSync(playerId, characterId)
        if (playerCharacterData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Character not owned."
        })

        // get character asset data
        const characterAssetData = getCharacterDataSync(characterId)
        if (characterAssetData === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No character asset data found."
        })

        // calculate new over limit
        const overLimitCount = body.over_limit_count
        if (!Number.isInteger(overLimitCount) || overLimitCount <= 0) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Over limit count must be a positive integer."
        })
        const newOverLimit = playerCharacterData.overLimitStep + overLimitCount
        const characterRarity = characterAssetData.rarity
        if (newOverLimit > characterMaxOverLimits[characterRarity]) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Character cannot be uncapped further."
        })

        let stack = playerCharacterData.stack
        const item_list: Record<number, number> = {}

        if (body.use_stack) {
            // stack uncapping
            
            // ensure that the character has enough stack
            stack = stack - overLimitCount
            if (0 > stack) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Character does not have enough duplicates to uncap."
            })

            // update the character
            updatePlayerCharacterSync(playerId, characterId, {
                overLimitStep: newOverLimit,
                stack: stack
            })
        } else {
            // item uncapping
            const itemId = body.item_id

            // ensure that the item trying to be used is valid
            // 5* characters can only be uncapped by item 10003 (awaking_crystal_5)
            // 4* characters and below can only be uncapped by items 10002 (awaking_crystal_4) and 10001 (awaking_crystal_3)
            if ( (characterRarity === 5 && itemId !== 10003) 
                || ( 4 >= characterRarity && (itemId !== 10002 && itemId !== 10001)) 
            ) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Attempted to use invalid item."
            })

            const itemData = getPlayerItemSync(playerId, itemId)
            if (itemData === null) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Attempted to use unowned item."
            })

            // make sure that the player has enough of the item
            const newAmount = itemData - overLimitCount
            if (0 > newAmount) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Not enough of item to uncap."
            })

            getDb().transaction(() => {
                updatePlayerItemSync(playerId, itemId, newAmount)
                updatePlayerCharacterSync(playerId, characterId, {
                    overLimitStep: newOverLimit
                })
            })()
            item_list[itemId] = newAmount
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "character_list": [
                    {
                        "over_limit_step": newOverLimit,
                        "character_id": characterId,
                        "stack": stack,
                        "create_time": clientSerializeDate(playerCharacterData.joinTime),
                        "update_time": clientSerializeDate(new Date()),
                        "join_time": clientSerializeDate(playerCharacterData.joinTime)
                    }
                ],
                "item_list": item_list,
                "mail_arrived": getMailArrivedSync(playerId)
            }
        })
    })

    fastify.post("/bulk_over_limit", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { viewer_id: number; api_count?: number }

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            error: "Bad Request", message: "Invalid request body.",
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            error: "Bad Request", message: "Invalid viewer id.",
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        const player = playerId !== null ? getPlayerSync(playerId) : null
        if (player === null) return reply.status(500).send({
            error: "Internal Server Error", message: "No players bound to account.",
        })

        const characters = getPlayerCharactersSync(playerId)
        console.log(`[bulk_over_limit] player=${playerId} totalChars=${Object.keys(characters).length}`)

        const characterList: any[] = []
        const updates: Array<{ characterId: number, overLimitStep: number, stack: number }> = []

        for (const [charId, charData] of Object.entries(characters)) {
            if (charData.stack <= 0) continue

            const assetData = getCharacterDataSync(Number(charId))
            if (!assetData) continue

            const maxOver = characterMaxOverLimits[assetData.rarity]
            if (maxOver === undefined) continue

            const rest = maxOver - charData.overLimitStep
            if (rest <= 0) continue

            const count = Math.min(charData.stack, rest)
            const newOverLimit = charData.overLimitStep + count
            const newStack = charData.stack - count

            updates.push({
                characterId: Number(charId),
                overLimitStep: newOverLimit,
                stack: newStack,
            })

            characterList.push({
                character_id: Number(charId),
                over_limit_step: newOverLimit,
                stack: newStack,
                create_time: clientSerializeDate(charData.joinTime),
                update_time: clientSerializeDate(new Date()),
                join_time: clientSerializeDate(charData.joinTime),
            })
        }

        getDb().transaction(() => {
            for (const update of updates) {
                updatePlayerCharacterSync(playerId, update.characterId, {
                    overLimitStep: update.overLimitStep,
                    stack: update.stack,
                })
            }
        })()

        console.log(`[bulk_over_limit] done: ${characterList.length} characters modified`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {
                character_list: characterList,
                mail_arrived: getMailArrivedSync(playerId),
            },
        })
    })

    fastify.post("/add_character_from_town", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { character_id: number, viewer_id: number, api_count: number }
        const viewerId = body.viewer_id
        const characterId = body.character_id
        if (!viewerId || isNaN(viewerId) || !characterId || isNaN(characterId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error", "message": "No player bound to account."
        })

        const giveResult = getDb().transaction(() => {
            if (!canClaimTownStoryCharacter(playerId, characterId)) return null
            return givePlayerCharacterSync(playerId, characterId)
        })()
        if (!giveResult?.character) return reply.status(400).send({
            "error": "Bad Request", "message": "Character is not available from town."
        })
        const existingCharacterList: Record<string, unknown>[] = giveResult?.character
            ? [giveResult.character as Record<string, unknown>]
            : []
        const itemList = giveResult?.item
            ? { [giveResult.item.id]: giveResult.item.count }
            : {}
        const characterList = existingCharacterList.length > 0
            ? reconcileAwakeUnlockCharacterList(playerId, existingCharacterList)
            : existingCharacterList

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "character_list": characterList,
                "item_list": itemList,
                "mail_arrived": getMailArrivedSync(playerId)
            }
        })
    })
}

export default routes;
