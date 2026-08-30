import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { getDatabaseStatus } from "../../data"
import {
    createNewsSync,
    deleteNewsSync,
    getAdminNewsSync,
    listAdminNewsSync,
    NewsNotFoundError,
    NewsRevisionConflictError,
    setNewsEnabledSync,
    updateNewsSync,
    validateNewsDraft,
} from "../../data/domains/news"

interface NewsParams {
    readonly id: string
}

function isDatabaseReady(): boolean {
    return getDatabaseStatus().ready
}

function parseInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null
}

function requireNewsId(request: FastifyRequest, reply: FastifyReply): number | null {
    const id = parseInteger((request.params as NewsParams).id)
    if (id === null) {
        void reply.status(404).send({ error: "公告不存在" })
        return null
    }
    return id
}

function sendRouteError(
    request: FastifyRequest,
    reply: FastifyReply,
    error: unknown,
): FastifyReply {
    if (error instanceof NewsNotFoundError) {
        return reply.status(404).send({ error: "公告不存在" })
    }
    if (error instanceof NewsRevisionConflictError) {
        return reply.status(409).send({ error: "公告已被其他操作修改，请刷新" })
    }
    if (error instanceof TypeError) {
        return reply.status(400).send({ error: "公告内容无效" })
    }
    request.log.error({ code: "ADMIN_NEWS_OPERATION_FAILED" }, "Admin news operation failed")
    return reply.status(500).send({ error: "公告操作失败" })
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        const query = request.query as { page?: string; pageSize?: string }
        const page = query.page === undefined ? 1 : parseInteger(query.page)
        const pageSize = query.pageSize === undefined ? 20 : parseInteger(query.pageSize, 100)
        if (page === null || pageSize === null) {
            return reply.status(400).send({ error: "公告内容无效" })
        }

        try {
            return reply.status(200).send({
                ...listAdminNewsSync(page, pageSize),
                page,
                pageSize,
            })
        } catch (error) {
            return sendRouteError(request, reply, error)
        }
    })

    fastify.get("/:id", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        const id = requireNewsId(request, reply)
        if (id === null) return reply

        try {
            const news = getAdminNewsSync(id)
            if (news === null) return reply.status(404).send({ error: "公告不存在" })
            return reply.status(200).send(news)
        } catch (error) {
            return sendRouteError(request, reply, error)
        }
    })

    fastify.post("/", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        try {
            return reply.status(201).send(createNewsSync(validateNewsDraft(request.body)))
        } catch (error) {
            return sendRouteError(request, reply, error)
        }
    })

    fastify.patch("/:id", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        const id = requireNewsId(request, reply)
        if (id === null) return reply

        try {
            const body = request.body as { revision?: unknown }
            const revision = typeof body?.revision === "number" ? body.revision : null
            if (revision === null) throw new TypeError("News revision is required")
            const { revision: _ignoredRevision, ...draft } = body as Record<string, unknown>
            return reply.status(200).send(
                updateNewsSync(id, revision, validateNewsDraft(draft)),
            )
        } catch (error) {
            return sendRouteError(request, reply, error)
        }
    })

    fastify.patch("/:id/enabled", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        const id = requireNewsId(request, reply)
        if (id === null) return reply

        try {
            const body = request.body as { enabled?: unknown; revision?: unknown }
            if (typeof body?.enabled !== "boolean" || typeof body.revision !== "number") {
                throw new TypeError("News enabled and revision are required")
            }
            return reply.status(200).send(setNewsEnabledSync(id, body.revision, body.enabled))
        } catch (error) {
            return sendRouteError(request, reply, error)
        }
    })

    fastify.delete("/:id", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        const id = requireNewsId(request, reply)
        if (id === null) return reply

        try {
            const query = request.query as { revision?: string }
            const revision = parseInteger(query.revision)
            if (revision === null) throw new TypeError("News revision is required")
            deleteNewsSync(id, revision)
            return reply.status(200).send({ ok: true })
        } catch (error) {
            return sendRouteError(request, reply, error)
        }
    })
}

export default routes
