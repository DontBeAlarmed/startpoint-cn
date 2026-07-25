// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAccountPlayers } from "../../data/domains/account"
import { getPlayerCharacterSync, getPlayerCharactersSync, updatePlayerCharacterSync } from "../../data/domains/character"
import { getPlayerItemsSync, givePlayerItemSync } from "../../data/domains/item"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { characterMaxOverLimits } from "./character";
import { givePlayerCharactersExpSync } from "../../lib/character";
import { generateDataHeaders, getServerTime } from "../../utils";
import { getCharacterDataSync } from "../../lib/assets";
import { clientSerializeDate } from "../../data/utils";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getDb } from "../../data/db";
import { incrementActiveMissionInjectedExpCountSync } from "../../data/domains/active_mission_counters"
import { validateCharacterStackConversion } from "../../lib/character-stack";
import { getMailArrivedSync } from "../../lib/mail-notification";

interface InjectExpBody {
    character_id: number,
    viewer_id: number,
    exp: number,
    api_count: number
}

interface StackToExpBody {
    character_id: number,
    api_count: number,
    number: number,
    viewer_id: number
}

interface BulkStackToExpBody {
    viewer_id: number
    api_count: number
}

const rarityStackConvertItemCount: Record<number, number> = {
    [1]: 2,
    [2]: 2,
    [3]: 2,
    [4]: 10,
    [5]: 30 
}
const rewardItemId = 990008

const rarityStackConvertExp: Record<number, number> = {
    [1]: 500,
    [2]: 500,
    [3]: 500,
    [4]: 2000,
    [5]: 10000
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/stack_to_exp", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as StackToExpBody

        const viewerId = body.viewer_id
        const characterId = body.character_id
        const convertCount = body.number
        if (isNaN(viewerId) || isNaN(characterId)) return reply.status(400).send({
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

        // get character asset data
        const characterAssetData = getCharacterDataSync(characterId)
        if (characterAssetData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Character does not exist."
        })

        // get character
        const character = getPlayerCharacterSync(playerId, characterId)
        if (character === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Player does not own character."
        })

        const validationError = validateCharacterStackConversion(character.stack, convertCount, character.protection)
        if (validationError) {
            console.warn(`[EXPOD] stack_to_exp rejected viewer=${viewerId} char=${characterId} count=${convertCount} reason=${validationError}`)
            return reply.status(400).send({
                "error": "Bad Request",
                "message": validationError
            })
        }
        
        const afterStack = character.stack - convertCount

        // get amounts to add
        const rarity = characterAssetData.rarity
        const increaseExp = rarityStackConvertExp[rarity] * convertCount
        const increaseItemCount = rarityStackConvertItemCount[rarity] * convertCount

        const afterExp = player.expPool + increaseExp

        let afterItemCount = 0
        getDb().transaction(() => {
            updatePlayerCharacterSync(playerId, characterId, { stack: afterStack })
            updatePlayerSync({
                id: playerId,
                expPool: afterExp
            })
            afterItemCount = givePlayerItemSync(playerId, rewardItemId, increaseItemCount)
        })()
        console.log(`[EXPOD] stack_to_exp viewer=${viewerId} char=${characterId} count=${convertCount} stack=${character.stack}->${afterStack}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "exp_pool": afterExp,
                    "exp_pooled_time": getServerTime(player.expPooledTime)
                },
                "character_list": [
                    {
                        "viewer_id": viewerId,
                        "character_id": characterId,
                        "stack": afterStack,
                        "exp": character.exp,
                        "exp_total": character.exp,
                        "create_time": clientSerializeDate(character.joinTime),
                        "update_time": clientSerializeDate(new Date()),
                        "join_time": clientSerializeDate(character.joinTime)
                    }
                ],
                "converted_exp_info": {
                    "add_exp": increaseExp
                },
                "item_list": {
                    [rewardItemId]: afterItemCount
                },
                "mail_arrived": getMailArrivedSync(playerId)
            }
        })
    })

    fastify.post("/bulk_stack_to_exp", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as BulkStackToExpBody

        const viewerId = body.viewer_id
        if (isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(session.accountId)!
        const player = playerId !== null ? getPlayerSync(playerId) : null
        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        const allCharacters = getPlayerCharactersSync(playerId)
        const modifiedCharacters: Object[] = []
        let totalExp = 0
        let totalStarGrains = 0
        let processedCount = 0

        for (const [characterIdStr, character] of Object.entries(allCharacters)) {
            const characterId = parseInt(characterIdStr)
            if (character.stack <= 0) continue

            const charAsset = getCharacterDataSync(characterId)
            if (!charAsset) continue

            const rarity = charAsset.rarity
            const maxOver = characterMaxOverLimits[rarity] ?? 0
            if (character.overLimitStep < maxOver) continue

            const stack = character.stack
            const addExp = (rarityStackConvertExp[rarity] ?? 0) * stack
            const addStarGrain = (rarityStackConvertItemCount[rarity] ?? 0) * stack

            totalExp += addExp
            totalStarGrains += addStarGrain

            updatePlayerCharacterSync(playerId, characterId, { stack: 0 })
            character.stack = 0

            modifiedCharacters.push({
                "viewer_id": viewerId,
                "character_id": characterId,
                "stack": 0,
                "over_limit_step": character.overLimitStep,
                "exp": character.exp,
                "exp_total": character.exp,
                "create_time": clientSerializeDate(character.joinTime),
                "update_time": clientSerializeDate(character.updateTime),
                "join_time": clientSerializeDate(character.joinTime)
            })
            processedCount++
        }

        if (processedCount === 0) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": {
                    "character_list": [],
                    "converted_exp_info": { "add_exp": 0 },
                    "item_list": getPlayerItemsSync(playerId),
                    "user_info": {
                        "exp_pool": player.expPool,
                        "exp_pooled_time": getServerTime(player.expPooledTime)
                    },
                    "mail_arrived": getMailArrivedSync(playerId)
                }
            })
        }

        const newExpPool = player.expPool + totalExp
        updatePlayerSync({ id: playerId, expPool: newExpPool })

        let newStarGrainTotal = 0
        if (totalStarGrains > 0) {
            newStarGrainTotal = givePlayerItemSync(playerId, rewardItemId, totalStarGrains)
        }

        const items = getPlayerItemsSync(playerId)
        if (totalStarGrains > 0) {
            items[String(rewardItemId)] = newStarGrainTotal
        }

        console.log(`[BULK_STACK_EXP] player ${playerId}: ${processedCount} characters converted, exp +${totalExp}, starGrain +${totalStarGrains}, expPool ${player.expPool}→${newExpPool}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "character_list": modifiedCharacters,
                "converted_exp_info": { "add_exp": totalExp },
                "item_list": items,
                "user_info": {
                    "exp_pool": newExpPool,
                    "exp_pooled_time": getServerTime(player.expPooledTime)
                },
                "mail_arrived": getMailArrivedSync(playerId)
            }
        })
    })

    fastify.post("/inject_exp", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as InjectExpBody

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

        // increase character exp
        const characterId = body.character_id
        const character = getPlayerCharacterSync(playerId, characterId)
        if (character === null) return reply.status(400).send({
            "error": "Internal Server Error",
            "message": "Player does not own character."
        })

        // make sure that the player has enough exp
        const addExp = Math.abs(body.exp)
        const playerExpPool = player.expPool
        if (addExp > playerExpPool) return reply.status(400).send({
            "error": "Internal Server Error",
            "message": "Not enough exp."
        })
        
        const playerAfterExpPool = player.expPool - addExp

        const rewardResult = getDb().transaction(() => {
            // 经验池扣除、角色经验写入和首次注入动作计数必须原子提交。
            updatePlayerSync({
                id: playerId,
                expPool: playerAfterExpPool,
            })
            const result = givePlayerCharactersExpSync(playerId, [characterId], addExp, false)
            incrementActiveMissionInjectedExpCountSync(playerId)
            return result
        })()

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "add_exp_list": rewardResult.add_exp_list,
                "character_list": rewardResult.character_list,
                "user_info": {
                    "exp_pool": rewardResult.exp_pool,
                    "exp_pooled_time": getServerTime(player.expPooledTime)
                },
                "mail_arrived": getMailArrivedSync(playerId)
            }
        })
    })
}

export default routes;
