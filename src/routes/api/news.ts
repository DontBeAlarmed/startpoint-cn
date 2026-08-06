/**
 * News / Announcement API.
 * Exact format from CN client decompiled code:
 *   NewsIndexRealRemote.as — expects { current_page, news, news_count }
 *   NewsGetInfoRealRemote.as — expects { id, title, date, html, label, thumbnail, added_time, thumbnail_path }
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession } from "../../data/domains/session"
import { claimForcedNewsDeliverySync } from "../../data/domains/news"
import { resolvePlayerIdSync } from "../../data/activeAccount"
import { findPendingForcedNews, loadVisibleNews, toClientNews } from "../../lib/news-catalog"
import { generateDataHeaders } from "../../utils";

const routes = async (fastify: FastifyInstance) => {
    // News list (paginated by page_index, category)
    fastify.post("/index", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body."
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer id."
        })

        const allNews = loadVisibleNews()
        const page = body.page_index || body.current_page || 1
        const perPage = 20
        const start = (page - 1) * perPage
        const items = allNews.slice(start, start + perPage)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {
                current_page: page,
                news: items.map(toClientNews),
                news_count: allNews.length,
            }
        })
    })

    // Single news detail
    fastify.post("/get_info", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body."
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer id."
        })

        const allNews = loadVisibleNews()
        const news = allNews.find(n => n.id === body.news_id)
        if (!news) return reply.status(400).send({
            error: "Bad Request",
            message: `News with id '${body.news_id}' not found.`
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {
                ...toClientNews(news),
            }
        })
    })

    // System news index (same format, different endpoint)
    fastify.post("/system_index", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: { current_page: 1, news: [], news_count: 0 }
        })
    })

    // System news detail (same format, different endpoint)
    fastify.post("/get_system_info", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {}
        })
    })

    // Latest forced news popup — claim once per player and announcement.
    fastify.post("/latest_forced", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })

        const playerId = resolvePlayerIdSync(session.accountId)
        const news = playerId === null ? null : findPendingForcedNews(playerId)
        if (playerId !== null && news !== null) {
            const claimed = claimForcedNewsDeliverySync(
                playerId,
                news.id,
            )
            if (claimed) {
                reply.header("content-type", "application/x-msgpack")
                return reply.status(200).send({
                    data_headers: generateDataHeaders({ viewer_id: viewerId }),
                    data: toClientNews(news),
                })
            }
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {}
        })
    })

    // System forced news — return empty
    fastify.post("/latest_forced_system", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {}
        })
    })
}

export default routes
