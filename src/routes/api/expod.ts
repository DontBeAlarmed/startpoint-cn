// Handles the insertion and conversion of character EXP.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { getPlayerCharacterSync, getPlayerCharactersSync } from "../../data/domains/character"
import { getPlayerItemsSync } from "../../data/domains/item"
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { clientSerializeDate } from "../../data/utils"
import { resolvePlayerIdSync } from "../../data/activeAccount"
import { getDb } from "../../data/db"
import { expPoolRealDateToClientTimestamp } from "../../lib/exp-pool-time"
import { getMailArrivedSync } from "../../lib/mail-notification"
import { getRealNow } from "../../runtime/time/game-time"
import { generateDataHeaders } from "../../utils"
import { CharacterGrowthError } from "../../lib/character-growth/errors"
import { executeInjectCharacterExp } from "../../lib/character-growth/commands/inject-exp"
import { executeStackToExp } from "../../lib/character-growth/commands/stack-to-exp"
import { executeBulkStackToExp } from "../../lib/character-growth/commands/bulk-stack-to-exp"

interface InjectExpBody {
    character_id: number
    viewer_id: number
    exp: number
    api_count: number
}

interface StackToExpBody {
    character_id: number
    api_count: number
    number: number
    viewer_id: number
}

interface BulkStackToExpBody {
    viewer_id: number
    api_count: number
}

function invalidRequest(reply: FastifyReply, message = "Invalid request body.") {
    return reply.status(400).send({ error: "Bad Request", message })
}

function growthFailure(reply: FastifyReply, error: unknown) {
    if (error instanceof CharacterGrowthError) {
        return reply.status(400).send({
            error: "Bad Request",
            message: error.message.replace(/^[A-Z_]+: /, ""),
        })
    }
    throw error
}

async function resolveViewerPlayer(viewerId: number): Promise<
    { kind: "invalid-viewer" } | { kind: "missing-player" } | { kind: "ok", playerId: number }
> {
    const session = await getSession(viewerId.toString())
    if (!session) return { kind: "invalid-viewer" }
    const playerId = resolvePlayerIdSync(session.accountId)
    if (playerId === null || getPlayerSync(playerId) === null) return { kind: "missing-player" }
    return { kind: "ok", playerId }
}

function characterListEntry(
    viewerId: number,
    characterId: number,
    character: NonNullable<ReturnType<typeof getPlayerCharacterSync>>,
    options: { readonly includeViewer?: boolean, readonly includeStack?: boolean, readonly includeOverLimit?: boolean } = {},
): Record<string, unknown> {
    const joinTime = character.joinTime instanceof Date ? character.joinTime : getRealNow()
    const updateTime = character.updateTime instanceof Date ? character.updateTime : getRealNow()
    return {
        ...(options.includeViewer === true ? { viewer_id: viewerId } : {}),
        character_id: characterId,
        ...(options.includeOverLimit === true ? { over_limit_step: character.overLimitStep } : {}),
        ...(options.includeStack === true ? { stack: character.stack } : {}),
        exp: character.exp,
        exp_total: character.exp,
        create_time: clientSerializeDate(joinTime),
        update_time: clientSerializeDate(updateTime),
        join_time: clientSerializeDate(joinTime),
    }
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/stack_to_exp", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as StackToExpBody
        const viewerId = body.viewer_id
        const characterId = body.character_id
        const convertCount = body.number
        if (!Number.isSafeInteger(viewerId) || viewerId <= 0
            || !Number.isSafeInteger(characterId) || characterId <= 0) {
            return invalidRequest(reply)
        }

        const resolved = await resolveViewerPlayer(viewerId)
        if (resolved.kind === "invalid-viewer") return invalidRequest(reply, "Invalid viewer id.")
        if (resolved.kind === "missing-player") {
            return reply.status(500).send({ error: "Internal Server Error", message: "No players bound to account." })
        }

        try {
            const result = executeStackToExp({
                playerId: resolved.playerId,
                characterId,
                useStackCount: convertCount,
                evaluationTime: getRealNow(),
            })
            const player = getPlayerSync(resolved.playerId)!
            const character = getPlayerCharacterSync(resolved.playerId, characterId)!
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                data_headers: generateDataHeaders({ viewer_id: viewerId }),
                data: {
                    user_info: {
                        exp_pool: result.expPool,
                        exp_pooled_time: expPoolRealDateToClientTimestamp(player.expPooledTime),
                    },
                    character_list: [characterListEntry(viewerId, characterId, character, {
                        includeViewer: true, includeStack: true,
                    })],
                    converted_exp_info: { add_exp: result.addExp },
                    item_list: { 990008: result.itemCount },
                    mail_arrived: getMailArrivedSync(resolved.playerId),
                },
            })
        } catch (error) {
            return growthFailure(reply, error)
        }
    })

    fastify.post("/bulk_stack_to_exp", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as BulkStackToExpBody
        const viewerId = body.viewer_id
        if (!Number.isSafeInteger(viewerId) || viewerId <= 0) return invalidRequest(reply)
        const resolved = await resolveViewerPlayer(viewerId)
        if (resolved.kind === "invalid-viewer") return invalidRequest(reply, "Invalid viewer id.")
        if (resolved.kind === "missing-player") {
            return reply.status(500).send({ error: "Internal Server Error", message: "No players bound to account." })
        }

        try {
            const result = executeBulkStackToExp({
                playerId: resolved.playerId,
                evaluationTime: getRealNow(),
            })
            const player = getPlayerSync(resolved.playerId)!
            const characters = getPlayerCharactersSync(resolved.playerId)
            const characterList = result.characters.map(character => (
                characterListEntry(viewerId, character.characterId, characters[String(character.characterId)]!, {
                    includeOverLimit: true, includeStack: true,
                })
            ))
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                data_headers: generateDataHeaders({ viewer_id: viewerId }),
                data: {
                    character_list: characterList,
                    converted_exp_info: { add_exp: result.addExp },
                    item_list: getPlayerItemsSync(resolved.playerId),
                    user_info: {
                        exp_pool: result.expPool,
                        exp_pooled_time: expPoolRealDateToClientTimestamp(player.expPooledTime),
                    },
                    mail_arrived: getMailArrivedSync(resolved.playerId),
                },
            })
        } catch (error) {
            return growthFailure(reply, error)
        }
    })

    fastify.post("/inject_exp", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as InjectExpBody
        const viewerId = body.viewer_id
        if (!Number.isSafeInteger(viewerId) || viewerId <= 0) return invalidRequest(reply)
        const resolved = await resolveViewerPlayer(viewerId)
        if (resolved.kind === "invalid-viewer") return invalidRequest(reply, "Invalid viewer id.")
        if (resolved.kind === "missing-player") {
            return reply.status(500).send({ error: "Internal Server Error", message: "No players bound to account." })
        }

        try {
            const result = getDb().transaction(() => {
                const growth = executeInjectCharacterExp({
                    playerId: resolved.playerId,
                    characterId: body.character_id,
                    addExp: body.exp,
                    evaluationTime: getRealNow(),
                })
                // Keep the transport adapter's return shape in one place while
                // the command owns all EXP/pool/counter writes.
                return growth
            })()
            const player = getPlayerSync(resolved.playerId)!
            const character = getPlayerCharacterSync(resolved.playerId, body.character_id)!
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                data_headers: generateDataHeaders({ viewer_id: viewerId }),
                data: {
                    add_exp_list: result.addExpList,
                    character_list: [characterListEntry(viewerId, body.character_id, character)],
                    user_info: {
                        exp_pool: result.expPool,
                        exp_pooled_time: expPoolRealDateToClientTimestamp(player.expPooledTime),
                    },
                    mail_arrived: getMailArrivedSync(resolved.playerId),
                },
            })
        } catch (error) {
            return growthFailure(reply, error)
        }
    })
}

export default routes
