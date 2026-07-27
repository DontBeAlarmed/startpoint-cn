import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import type { ReadonlyCharacterElectionTable } from "../../content/converters/character-election"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { resolvePlayerIdSync } from "../../data/activeAccount"
import {
    getPlayerCharacterElectionVoteSync,
    recordPlayerCharacterElectionVoteSync,
} from "../../data/domains/character_election"
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import {
    getValidatedCharacterElectionRule,
    isCharacterElectionOpenAt,
} from "../../lib/character-election"
import { getOpenCharacterElectionVoteMissionId } from "../../lib/mission/event-entry-facts"
import { generateDataHeaders, getServerTime } from "../../utils"

interface ElectionBody {
    readonly viewer_id?: unknown
    readonly election_id?: unknown
    readonly keyword_id?: unknown
}

export interface CharacterElectionRoutesOptions {
    readonly getTable?: () => ReadonlyCharacterElectionTable
    readonly now?: () => Date
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function sendBadRequest(reply: FastifyReply, message: string) {
    return reply.status(400).send({ error: "Bad Request", message })
}

function sendMsgpack(
    reply: FastifyReply,
    viewerId: number,
    resultCode: number,
    data: Record<string, unknown>,
) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        data_headers: generateDataHeaders({ viewer_id: viewerId, result_code: resultCode }),
        data,
    })
}

async function resolvePlayer(body: ElectionBody, reply: FastifyReply): Promise<{
    readonly viewerId: number
    readonly playerId: number
} | null> {
    if (!isPositiveSafeInteger(body.viewer_id)) {
        sendBadRequest(reply, "Invalid request body.")
        return null
    }
    const session = await getSession(String(body.viewer_id))
    if (!session) {
        sendBadRequest(reply, "Invalid viewer id.")
        return null
    }
    const playerId = resolvePlayerIdSync(session.accountId)
    if (playerId === null || !getPlayerSync(playerId)) {
        sendBadRequest(reply, "Invalid player.")
        return null
    }
    return { viewerId: body.viewer_id, playerId }
}

export default async function characterElectionRoutes(
    fastify: FastifyInstance,
    options: CharacterElectionRoutesOptions = {},
): Promise<void> {
    const getTable = options.getTable ?? (() => (
        getContentSnapshot().repository.table<ReadonlyCharacterElectionTable>(
            "character_election.json",
        )
    ))
    const now = options.now ?? (() => new Date(getServerTime() * 1000))

    fastify.post("/get_vote_status", async (
        request: FastifyRequest,
        reply: FastifyReply,
    ) => {
        const body = (request.body ?? {}) as ElectionBody
        const context = await resolvePlayer(body, reply)
        if (!context) return
        if (!isPositiveSafeInteger(body.election_id)) {
            return sendBadRequest(reply, "Invalid election id.")
        }
        const rule = getValidatedCharacterElectionRule(getTable(), body.election_id)
        if (!rule) return sendBadRequest(reply, "Unknown character election.")
        const evaluationTime = now()
        if (!isCharacterElectionOpenAt(rule, evaluationTime)) {
            return sendMsgpack(reply, context.viewerId, 11003, {})
        }
        return sendMsgpack(reply, context.viewerId, 1, {
            is_voted: getPlayerCharacterElectionVoteSync(
                context.playerId,
                body.election_id,
            ) !== null,
        })
    })

    fastify.post("/vote", async (
        request: FastifyRequest,
        reply: FastifyReply,
    ) => {
        const body = (request.body ?? {}) as ElectionBody
        const context = await resolvePlayer(body, reply)
        if (!context) return
        if (!isPositiveSafeInteger(body.election_id)
            || !isPositiveSafeInteger(body.keyword_id)) {
            return sendBadRequest(reply, "Invalid character election vote.")
        }
        const rule = getValidatedCharacterElectionRule(getTable(), body.election_id)
        if (!rule) return sendBadRequest(reply, "Unknown character election.")
        const evaluationTime = now()
        if (!isCharacterElectionOpenAt(rule, evaluationTime)) {
            return sendMsgpack(reply, context.viewerId, 11003, {})
        }
        if (!rule.keywordIdSet.has(body.keyword_id)) {
            return sendBadRequest(reply, "Invalid character election keyword.")
        }
        const missionId = getOpenCharacterElectionVoteMissionId(
            rule.stringId,
            rule.startTime,
            rule.endTime,
            evaluationTime,
        )
        if (missionId === null) {
            return sendBadRequest(reply, "Character election mission is unavailable.")
        }
        recordPlayerCharacterElectionVoteSync(
            context.playerId,
            body.election_id,
            body.keyword_id,
            Math.floor(evaluationTime.getTime() / 1000),
            missionId,
        )
        return sendMsgpack(reply, context.viewerId, 1, {})
    })
}
