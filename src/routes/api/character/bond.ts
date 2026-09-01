// Character bond token and mana board opening endpoints

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { getPlayerCharacterSync } from "../../../data/domains/character"
import { getDb } from "../../../data/db"
import { getMailArrivedSync } from "../../../lib/mail-notification"
import {
    sendCharacterResponse,
    validateSessionAndPlayer,
} from "../../../lib/character-helpers"
import { mergeMissionSettlementResponse } from "../../../lib/mission"
import { receiveBondToken } from "../../../lib/character-growth/commands/receive-bond-token"
import { openManaBoard } from "../../../lib/character-growth/commands/open-mana-board"
import { getServerDate } from "../../../utils"
import { publishCharacterGrowthOwnerStateBestEffort } from "../../../lib/character-growth/owner-publication"
import { MANA_CHARACTER_GROWTH_FIELDS, projectCharacterGrowthIncrement } from "../../../lib/character-growth/response-projector"
import { sendGrowthMutationError } from "./mana-mutation-http"

interface CharacterGrowthRequestBody {
    character_id: number
    mana_board_index: number
    api_count: number
    viewer_id: number
}

function isValidRequestBody(body: CharacterGrowthRequestBody): boolean {
    return Number.isSafeInteger(body?.viewer_id)
        && Number.isSafeInteger(body?.character_id)
        && Number.isSafeInteger(body?.mana_board_index)
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/receive_bond_token", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CharacterGrowthRequestBody
        if (!isValidRequestBody(body)) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }

        const sess = await validateSessionAndPlayer(body.viewer_id, reply)
        if (!sess) return

        try {
            const settlement = getDb().transaction(() => {
                const result = receiveBondToken({
                    playerId: sess.playerId,
                    characterId: body.character_id,
                    manaBoardIndex: body.mana_board_index,
                    evaluationTime: getServerDate(),
                })
                const character = getPlayerCharacterSync(sess.playerId, body.character_id)
                if (character === null) {
                    throw new Error("bond token command completed without authoritative state")
                }
                const existingCharacterList = [...projectCharacterGrowthIncrement(result, {
                    character,
                    fields: MANA_CHARACTER_GROWTH_FIELDS,
                }).character_list]
                return {
                    bondTokenAfter: result.playerBondTokenAfter,
                    characterList: result.replayed
                        ? existingCharacterList
                        : publishCharacterGrowthOwnerStateBestEffort(
                            sess.playerId,
                            [body.character_id],
                            [existingCharacterList],
                            {},
                            "character/receive_bond_token",
                            getServerDate(),
                        ).characterList,
                }
            })()
            return sendCharacterResponse(reply, body.viewer_id, {
                user_info: { bond_token: settlement.bondTokenAfter },
                character_list: settlement.characterList,
                user_character_mana_node_list: {},
                item_list: {},
                evolution: [],
                mail_arrived: getMailArrivedSync(sess.playerId),
            })
        } catch (error) {
            if (sendGrowthMutationError(reply, error)) return
            throw error
        }
    })

    fastify.post("/open_mana_board", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CharacterGrowthRequestBody
        if (!isValidRequestBody(body)) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }

        const sess = await validateSessionAndPlayer(body.viewer_id, reply)
        if (!sess) return

        try {
            const result = openManaBoard({
                playerId: sess.playerId,
                characterId: body.character_id,
                targetBoardIndex: body.mana_board_index,
                evaluationTime: getServerDate(),
            })
            const growthProjection = projectCharacterGrowthIncrement(result, {
                character: result.character,
                fields: [...MANA_CHARACTER_GROWTH_FIELDS, "mana_board_index"],
                viewerId: body.viewer_id,
            })
            const responseData = {
                user_info: {},
                character_list: [...growthProjection.character_list],
                user_character_mana_node_list: {},
                item_list: {},
                evolution: [],
                mail_arrived: getMailArrivedSync(sess.playerId),
                mission_info: [],
                equipment_list: [],
                degree_list: [],
            }
            if (result.missionSettlement !== null) {
                mergeMissionSettlementResponse(responseData, result.missionSettlement, body.viewer_id)
            }
            return sendCharacterResponse(reply, body.viewer_id, responseData)
        } catch (error) {
            if (sendGrowthMutationError(reply, error)) return
            throw error
        }
    })
}

export default routes
