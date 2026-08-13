import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { resolvePlayerIdSync } from "../../data/activeAccount"
import { getDb } from "../../data/db"
import { getPlayerMailCountSync } from "../../data/domains/mail"
import {
    getPlayerPassCardRewardRecordsSync,
    getPlayerPassCardStateSync,
    setPlayerPassCardPurchasedSync,
    setPlayerPassCardRewardReceivedSync,
} from "../../data/domains/pass-card"
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { MissionRewardGranter } from "../../lib/mission/grants"
import { getPassCardEventDefinition, getPassCardRewardDefinition, isPassCardEventActiveAt } from "../../lib/pass-card"
import { generateDataHeaders, getServerTime } from "../../utils"

interface PassCardBody {
    viewer_id: number
    pass_card_id: number
}

interface PassCardReceiveBody extends PassCardBody {
    all_receive?: number[]
    reward1_receive?: number[]
    reward2_receive?: number[]
}

interface RequestedTracks {
    receive1: boolean
    receive2: boolean
}

function isPassCardBody(body: unknown): body is PassCardBody {
    return typeof body === "object" && body !== null && !Array.isArray(body)
}

async function resolvePlayerId(body: PassCardBody, reply: FastifyReply): Promise<number | undefined> {
    if (!Number.isSafeInteger(body.viewer_id) || !Number.isSafeInteger(body.pass_card_id)) {
        reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        return undefined
    }
    const session = await getSession(String(body.viewer_id))
    const playerId = session ? resolvePlayerIdSync(session.accountId) : null
    if (playerId === null || playerId === undefined) {
        reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })
        return undefined
    }
    return playerId
}

function responseRecords(playerId: number, eventId: number) {
    return getPlayerPassCardRewardRecordsSync(playerId, eventId).map(record => ({
        reward_id: record.rewardId,
        is_received_1: record.isReceived1,
        is_received_2: record.isReceived2,
    }))
}

function collectRequestedTracks(body: PassCardReceiveBody): Map<number, RequestedTracks> | undefined {
    const result = new Map<number, RequestedTracks>()
    const add = (values: unknown, receive1: boolean, receive2: boolean): boolean => {
        if (!Array.isArray(values)) return false
        for (const rewardId of values) {
            if (!Number.isSafeInteger(rewardId)) return false
            const tracks = result.get(rewardId) ?? { receive1: false, receive2: false }
            tracks.receive1 ||= receive1
            tracks.receive2 ||= receive2
            result.set(rewardId, tracks)
        }
        return true
    }
    if (!add(body.all_receive ?? [], true, true)
        || !add(body.reward1_receive ?? [], true, false)
        || !add(body.reward2_receive ?? [], false, true)) return undefined
    return result
}

export default async function passCardRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.post("/get_pass_card", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body
        if (!isPassCardBody(body)) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }
        const playerId = await resolvePlayerId(body, reply)
        if (playerId === undefined) return
        const event = getPassCardEventDefinition(body.pass_card_id)
        if (!event || !isPassCardEventActiveAt(event, new Date(getServerTime() * 1000))) {
            return reply.status(400).send({ error: "Bad Request", message: "Unknown pass card." })
        }
        setPlayerPassCardPurchasedSync(playerId, body.pass_card_id)
        const state = getPlayerPassCardStateSync(playerId, body.pass_card_id)
        reply.header("content-type", "application/x-msgpack")
        return reply.send({
            data_headers: generateDataHeaders({ viewer_id: body.viewer_id }),
            data: {
                point: state.point,
                is_buy: state.isBuy,
                all_received_record: responseRecords(playerId, body.pass_card_id),
            },
        })
    })

    fastify.post("/receive_all", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body
        if (!isPassCardBody(body)) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }
        const playerId = await resolvePlayerId(body, reply)
        if (playerId === undefined) return
        const event = getPassCardEventDefinition(body.pass_card_id)
        const requested = collectRequestedTracks(body as PassCardReceiveBody)
        if (!event
            || !isPassCardEventActiveAt(event, new Date(getServerTime() * 1000))
            || !requested) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid pass reward request." })
        }

        const state = getPlayerPassCardStateSync(playerId, body.pass_card_id)
        const currentLevel = Math.floor(state.point / event.levelThreshold)
        const definitions = new Map<number, ReturnType<typeof getPassCardRewardDefinition>>()
        for (const [rewardId, tracks] of requested) {
            const definition = getPassCardRewardDefinition(rewardId)
            if (!definition
                || definition.eventId !== body.pass_card_id
                || definition.level > currentLevel
                || (tracks.receive2 && !state.isBuy)) {
                return reply.status(400).send({ error: "Bad Request", message: "Pass reward is not available." })
            }
            definitions.set(rewardId, definition)
        }

        const result = getDb().transaction(() => {
            const player = getPlayerSync(playerId)
            if (!player) throw new Error(`Player ${playerId} not found during pass reward settlement.`)
            const granter = new MissionRewardGranter(playerId, player)
            const received = new Map(
                getPlayerPassCardRewardRecordsSync(playerId, body.pass_card_id)
                    .map(record => [record.rewardId, record]),
            )
            for (const [rewardId, tracks] of requested) {
                const definition = definitions.get(rewardId)!
                const current = received.get(rewardId)
                const grant1 = tracks.receive1 && current?.isReceived1 !== 1
                const grant2 = tracks.receive2 && current?.isReceived2 !== 1
                if (grant1) granter.grant([definition.reward1])
                if (grant2) granter.grant([definition.reward2])
                if (grant1 || grant2) {
                    setPlayerPassCardRewardReceivedSync(
                        playerId,
                        body.pass_card_id,
                        rewardId,
                        grant1,
                        grant2,
                    )
                }
            }
            granter.persistPlayer()
            return granter
        })()

        reply.header("content-type", "application/x-msgpack")
        return reply.send({
            data_headers: generateDataHeaders({ viewer_id: body.viewer_id }),
            data: {
                all_received_record: responseRecords(playerId, body.pass_card_id),
                item_list: result.itemList,
                character_list: result.characterList,
                equipment_list: result.equipmentList,
                degree_list: result.degreeList.map(degreeId => ({
                    viewer_id: body.viewer_id,
                    degree_id: degreeId,
                })),
                ...(result.hasPlayerChanges() ? { user_info: result.getUserInfo() } : {}),
                mail_arrived: getPlayerMailCountSync(playerId, true) > 0,
            },
        })
    })
}
