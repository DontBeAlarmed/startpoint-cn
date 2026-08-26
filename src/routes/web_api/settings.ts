import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import {
    getServerGameplaySettingsSync,
    updateServerGameplaySettingsSync,
} from "../../data/domains/server-settings"

interface GameplaySettingsBody {
    readonly dropMultiplier?: unknown
    readonly multiRescueFragmentRewardsEnabled?: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/gameplay", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.status(200).send(getServerGameplaySettingsSync())
    })

    fastify.patch("/gameplay", async (request: FastifyRequest, reply: FastifyReply) => {
        if (!isPlainObject(request.body) || Object.keys(request.body).length !== 1) {
            return reply.status(400).send({ error: "请求必须只包含一个游戏设置字段" })
        }
        const body = request.body as GameplaySettingsBody
        const hasMultiplier = Object.prototype.hasOwnProperty.call(body, "dropMultiplier")
        const hasRescueSetting = Object.prototype.hasOwnProperty.call(body, "multiRescueFragmentRewardsEnabled")
        if (!hasMultiplier && !hasRescueSetting) {
            return reply.status(400).send({ error: "未知的游戏设置字段" })
        }
        if (hasMultiplier && (!Number.isSafeInteger(body.dropMultiplier)
            || (body.dropMultiplier as number) < 1
            || (body.dropMultiplier as number) > 10)) {
            return reply.status(400).send({ error: "掉落倍率必须是 1 到 10 之间的整数" })
        }
        if (hasRescueSetting && typeof body.multiRescueFragmentRewardsEnabled !== "boolean") {
            return reply.status(400).send({ error: "多人救援碎片开关必须是布尔值" })
        }
        const current = getServerGameplaySettingsSync()
        return reply.status(200).send(updateServerGameplaySettingsSync({
            dropMultiplier: hasMultiplier ? body.dropMultiplier as number : current.dropMultiplier,
            multiRescueFragmentRewardsEnabled: hasRescueSetting
                ? body.multiRescueFragmentRewardsEnabled as boolean : undefined,
        }))
    })
}

export default routes
