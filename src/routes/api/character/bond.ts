// Character bond token and mana board opening endpoints

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { getPlayerCharacterSync } from "../../../data/domains/character"
import { getPlayerSync } from "../../../data/domains/player"
import { getDb } from "../../../data/db"
import { getMailArrivedSync } from "../../../lib/mail-notification"
import {
    buildCharacterListEntry,
    sendCharacterResponse,
    validateCharacterOwnership,
    validateSessionAndPlayer,
} from "../../../lib/character-helpers"
import { mergeMissionSettlementResponse } from "../../../lib/mission"
import { CharacterGrowthError } from "../../../lib/character-growth/errors"
import { receiveBondToken } from "../../../lib/character-growth/commands/receive-bond-token"
import { openManaBoard } from "../../../lib/character-growth/commands/open-mana-board"
import { getServerDate } from "../../../utils"
import { createAwakeRequestContextBestEffort } from "../../../lib/mission/awake-best-effort-context"
import { reconcileAwakeUnlockCharacterListBestEffort } from "../../../lib/mission/awake-unlock-response"

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

function sendGrowthError(reply: FastifyReply, error: unknown): boolean {
    if (!(error instanceof CharacterGrowthError)) return false
    const statusCode = error.code === "CONTENT_INVALID" ? 500 : 400
    reply.status(statusCode).send({
        error: statusCode === 400 ? "Bad Request" : "Internal Server Error",
        message: error.message,
    })
    return true
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/receive_bond_token", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CharacterGrowthRequestBody
        if (!isValidRequestBody(body)) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }

        const sess = await validateSessionAndPlayer(body.viewer_id, reply)
        if (!sess) return
        if (!validateCharacterOwnership(sess.playerId, body.character_id, reply)) return

        try {
            const characterList = getDb().transaction(() => {
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
                const existingCharacterList = [buildCharacterListEntry(body.character_id, character)]
                if (result.replayed) return existingCharacterList
                const awakeContext = createAwakeRequestContextBestEffort(
                    sess.playerId,
                    [body.character_id],
                )
                return awakeContext === null
                    ? existingCharacterList
                    : reconcileAwakeUnlockCharacterListBestEffort(
                        sess.playerId,
                        existingCharacterList,
                        { context: awakeContext, candidateCharacterIds: [body.character_id] },
                    )
            })()
            const player = getPlayerSync(sess.playerId)
            if (player === null) throw new Error("bond token command completed without player state")
            return sendCharacterResponse(reply, body.viewer_id, {
                user_info: { bond_token: player.bondToken },
                character_list: characterList,
                user_character_mana_node_list: {},
                item_list: {},
                evolution: [],
                mail_arrived: getMailArrivedSync(sess.playerId),
            })
        } catch (error) {
            if (sendGrowthError(reply, error)) return
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
        if (!validateCharacterOwnership(sess.playerId, body.character_id, reply)) return

        try {
            const result = openManaBoard({
                playerId: sess.playerId,
                characterId: body.character_id,
                targetBoardIndex: body.mana_board_index,
                evaluationTime: getServerDate(),
            })
            const player = getPlayerSync(sess.playerId)
            const character = getPlayerCharacterSync(sess.playerId, body.character_id)
            if (player === null || character === null) {
                throw new Error("mana board command completed without authoritative state")
            }
            const responseData = {
                user_info: {},
                character_list: [buildCharacterListEntry(body.character_id, character, {
                    viewer_id: body.viewer_id,
                    mana_board_index: result.after.manaBoardIndex,
                })],
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
            responseData.mail_arrived = getMailArrivedSync(sess.playerId)
            return sendCharacterResponse(reply, body.viewer_id, responseData)
        } catch (error) {
            if (sendGrowthError(reply, error)) return
            throw error
        }
    })
}

export default routes
