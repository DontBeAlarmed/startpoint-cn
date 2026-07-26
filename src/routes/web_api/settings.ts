import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import {
    getServerGameplaySettingsSync,
    updateServerGameplaySettingsSync,
} from "../../data/domains/server-settings"

interface GameplaySettingsBody {
    readonly dropMultiplier?: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/gameplay", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.status(200).send(getServerGameplaySettingsSync())
    })

    fastify.patch("/gameplay", async (request: FastifyRequest, reply: FastifyReply) => {
        if (!isPlainObject(request.body)
            || Object.keys(request.body).length !== 1
            || !Object.prototype.hasOwnProperty.call(request.body, "dropMultiplier")) {
            return reply.status(400).send({ error: "请求必须只包含 dropMultiplier" })
        }
        const { dropMultiplier } = request.body as GameplaySettingsBody
        if (!Number.isSafeInteger(dropMultiplier)
            || (dropMultiplier as number) < 1
            || (dropMultiplier as number) > 10) {
            return reply.status(400).send({ error: "掉落倍率必须是 1 到 10 之间的整数" })
        }
        return reply.status(200).send(updateServerGameplaySettingsSync({
            dropMultiplier: dropMultiplier as number,
        }))
    })
}

export default routes
