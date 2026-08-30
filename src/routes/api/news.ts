import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession } from "../../data/domains/session"
import {
    getVisibleNewsForClient,
    listVisibleNewsForClient,
    toClientNews,
} from "../../lib/news-catalog"
import { generateDataHeaders } from "../../utils";

type NewsCategory = 1 | 2 | 3

function requireCategory(value: unknown): NewsCategory {
    if (value !== 1 && value !== 2 && value !== 3) {
        throw new TypeError("category must be 1, 2, or 3")
    }
    return value
}

function requirePositiveInteger(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`${label} must be a positive integer`)
    }
    return value
}

async function requireViewer(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<number | null> {
    const body = request.body as { viewer_id?: unknown } | null | undefined
    const viewerId = body?.viewer_id
    if (typeof viewerId !== "number" || !Number.isSafeInteger(viewerId)) {
        await reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body."
        })
        return null
    }

    const session = await getSession(viewerId.toString())
    if (!session) {
        await reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer id."
        })
        return null
    }
    return viewerId
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/index", async (request: FastifyRequest, reply: FastifyReply) => {
        const viewerId = await requireViewer(request, reply)
        if (viewerId === null) return reply

        const body = request.body as Record<string, unknown>
        let category: NewsCategory
        let page: number
        try {
            category = requireCategory(body.category)
            page = requirePositiveInteger(body.page_index, "page_index")
        } catch (error) {
            if (!(error instanceof TypeError)) throw error
            return reply.status(400).send({
                error: "Bad Request",
                message: error.message,
            })
        }

        const { rows, totalCount } = listVisibleNewsForClient({ category, page })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {
                current_page: page,
                news: rows.map(toClientNews),
                news_count: totalCount,
            },
        })
    })

    fastify.post("/get_info", async (request: FastifyRequest, reply: FastifyReply) => {
        const viewerId = await requireViewer(request, reply)
        if (viewerId === null) return reply

        const body = request.body as { news_id?: unknown }
        let newsId: number
        try {
            newsId = requirePositiveInteger(body.news_id, "news_id")
        } catch (error) {
            if (!(error instanceof TypeError)) throw error
            return reply.status(400).send({
                error: "Bad Request",
                message: error.message,
            })
        }
        const news = getVisibleNewsForClient(newsId)
        if (news === null) {
            return reply.status(400).send({
                error: "Bad Request",
                message: `News with id '${body.news_id}' not found.`
            })
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: toClientNews(news),
        })
    })

    fastify.post("/system_index", async (request: FastifyRequest, reply: FastifyReply) => {
        const viewerId = await requireViewer(request, reply)
        if (viewerId === null) return reply

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: { current_page: 1, news: [], news_count: 0 }
        })
    })

    fastify.post("/get_system_info", async (request: FastifyRequest, reply: FastifyReply) => {
        const viewerId = await requireViewer(request, reply)
        if (viewerId === null) return reply

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {}
        })
    })

    fastify.post("/latest_forced", async (request: FastifyRequest, reply: FastifyReply) => {
        const viewerId = await requireViewer(request, reply)
        if (viewerId === null) return reply

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {}
        })
    })

    fastify.post("/latest_forced_system", async (request: FastifyRequest, reply: FastifyReply) => {
        const viewerId = await requireViewer(request, reply)
        if (viewerId === null) return reply

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {}
        })
    })
}

export default routes
