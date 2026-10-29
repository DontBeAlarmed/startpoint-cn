import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { resolvePlayerIdSync } from "../../data/activeAccount"
import { getSession } from "../../data/domains/session"
import { generateDataHeaders } from "../../utils"
import {
    projectGrowthFundReceiveResponse,
    receiveGrowthFundBonusSync,
} from "../../lib/growth-fund"

interface ReceiveBody {
    viewer_id: number
    bonus_ids: number[]
    api_count?: number
}

function positiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0
}

const routes = async (fastify: FastifyInstance): Promise<void> => {
    fastify.post("/receive_fund_bonus", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveBody
        const viewerId = body.viewer_id
        const bonusIds = body.bonus_ids
        if (!positiveInteger(viewerId)
            || !Array.isArray(bonusIds)
            || !bonusIds.every(positiveInteger)) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }
        const session = await getSession(String(viewerId))
        if (session === null) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })
        }
        const playerId = resolvePlayerIdSync(session.accountId)
        if (playerId === null) {
            return reply.status(500).send({
                error: "Internal Server Error",
                message: "No players bound to account.",
            })
        }

        const result = receiveGrowthFundBonusSync({ playerId, bonusIds })
        reply.header("content-type", "application/x-msgpack")
        if (!result.ok) {
            // 客户端无专属错误分支（资格由客户端预检），显式 result_code 0 走
            // 通用错误弹窗（默认 1 是客户端成功码——双审 P1，禁止沿用）。
            console.warn(`[GROWTH_FUND] receive rejected: ${result.message}`)
            return reply.status(200).send({
                data_headers: generateDataHeaders({ viewer_id: viewerId, result_code: 0 }),
                data: {},
            })
        }
        return reply.status(200).send(projectGrowthFundReceiveResponse({
            dataHeaders: generateDataHeaders({ viewer_id: viewerId }),
            result: result.result,
        }))
    })
}

export default routes
