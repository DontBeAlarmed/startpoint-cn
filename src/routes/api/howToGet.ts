import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { resolvePlayerIdSync } from "../../data/activeAccount"
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import {
    getHowToGetListSync,
    HowToGetTarget,
} from "../../lib/how-to-get"
import { generateDataHeaders, getServerTime } from "../../utils"
import { getRealNowMs } from "../../runtime/time/game-time"

interface HowToGetBody {
    readonly viewer_id?: unknown
    readonly item_id?: unknown
    readonly equipment_id?: unknown
}

export interface HowToGetRoutesOptions {
    readonly now?: () => number
    readonly realNow?: () => number
    readonly dailyResetHour?: number
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function parseTarget(body: HowToGetBody): HowToGetTarget | null {
    const hasItemId = Object.prototype.hasOwnProperty.call(body, "item_id")
    const hasEquipmentId = Object.prototype.hasOwnProperty.call(body, "equipment_id")
    if (hasItemId === hasEquipmentId) return null
    if (hasItemId && isPositiveSafeInteger(body.item_id)) {
        return { kind: "item", id: body.item_id }
    }
    if (hasEquipmentId && isPositiveSafeInteger(body.equipment_id)) {
        return { kind: "equipment", id: body.equipment_id }
    }
    return null
}

function sendBadRequest(reply: FastifyReply, message: string) {
    return reply.status(400).send({ error: "Bad Request", message })
}

export default async function howToGetRoutes(
    fastify: FastifyInstance,
    options: HowToGetRoutesOptions = {},
): Promise<void> {
    const now = options.now ?? (() => getServerTime() * 1000)
    const realNow = options.realNow ?? getRealNowMs

    fastify.post("/get_list", async (
        request: FastifyRequest,
        reply: FastifyReply,
    ) => {
        const body = (request.body ?? {}) as HowToGetBody
        const target = parseTarget(body)
        if (target === null || !isPositiveSafeInteger(body.viewer_id)) {
            return sendBadRequest(reply, "Invalid request body.")
        }
        const session = await getSession(String(body.viewer_id))
        if (!session) return sendBadRequest(reply, "Invalid viewer id.")
        const playerId = resolvePlayerIdSync(session.accountId)
        if (playerId === null || getPlayerSync(playerId) === null) {
            return sendBadRequest(reply, "Invalid player.")
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: body.viewer_id }),
            data: getHowToGetListSync(
                playerId,
                target,
                now(),
                realNow(),
                options.dailyResetHour ?? 5,
            ),
        })
    })
}
