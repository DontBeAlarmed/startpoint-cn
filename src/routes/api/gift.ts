import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { resolvePlayerIdSync } from "../../data/activeAccount"
import { getSession } from "../../data/domains/session"
import { getPlayerSync } from "../../data/domains/player"
import { SessionType } from "../../data/types"
import { receiveGiftCodeSync } from "../../lib/gift-code/redemption"
import { projectItemOverflowCommonResponse } from "../../lib/item-overflow"
import { generateDataHeaders } from "../../utils"

function isRequestBody(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/receive", async (request: FastifyRequest, reply: FastifyReply) => {
        if (!isRequestBody(request.body)) {
            return reply.status(400).send({
                error: "Bad Request",
                message: "Invalid request body",
            })
        }

        const viewerId = request.body.viewer_id
        const key = request.body.key
        if (typeof viewerId !== "number" || !Number.isSafeInteger(viewerId)
            || viewerId < 1 || typeof key !== "string") {
            return reply.status(400).send({
                error: "Bad Request",
                message: "Invalid viewer_id or key",
            })
        }

        const session = await getSession(String(viewerId))
        if (session === null || session.type !== SessionType.VIEWER) {
            return reply.status(400).send({
                error: "Bad Request",
                message: "Invalid viewer_id",
            })
        }

        const playerId = resolvePlayerIdSync(session.accountId)
        const player = playerId === null ? null : getPlayerSync(playerId)
        if (playerId === null || player === null) {
            return reply.status(400).send({
                error: "Bad Request",
                message: "No player bound to account",
            })
        }

        let result
        try {
            result = receiveGiftCodeSync(playerId, key)
        } catch {
            request.log.error({ scope: "gift-redemption" }, "Gift redemption failed")
            return reply.status(500).send({
                statusCode: 500,
                error: "Internal Server Error",
                message: "Gift redemption failed",
            })
        }

        reply.header("content-type", "application/x-msgpack")
        const data: Record<string, unknown> = {
            result_code: result.resultCode,
            all_gift_info: result.rewards.map(reward => ({
                type: reward.type,
                type_id: reward.typeId,
                number: reward.number,
            })),
        }
        if (result.resultCode === 1 && result.itemOverflow !== undefined) {
            const overMax = projectItemOverflowCommonResponse(result.itemOverflow.dispositions)
            if (overMax.length > 0) {
                data.over_max = overMax
                data.item_list = result.itemOverflow.itemList
                if (result.itemOverflow.freeManaAfter !== null) {
                    data.user_info = { free_mana: result.itemOverflow.freeManaAfter }
                }
            }
        }
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data,
        })
    })
}

export default routes
