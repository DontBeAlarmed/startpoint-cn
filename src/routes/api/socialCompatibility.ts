import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { getSession } from "../../data/domains/session"
import { generateDataHeaders } from "../../utils"

async function resolveViewerId(request: FastifyRequest, reply: FastifyReply): Promise<number | null> {
    const viewerId = (request.body as { viewer_id?: unknown })?.viewer_id
    if (!Number.isSafeInteger(viewerId) || (viewerId as number) <= 0) {
        reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        return null
    }
    if (!await getSession(String(viewerId))) {
        reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })
        return null
    }
    return viewerId as number
}

export const followCompatibilityRoutes = async (fastify: FastifyInstance) => {
    fastify.post("/lists", async (request, reply) => {
        const viewerId = await resolveViewerId(request, reply)
        if (viewerId === null) return
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: { follow_info: [], followed_count: 0 },
        })
    })
}

export const snsCompatibilityRoutes = async (fastify: FastifyInstance) => {
    fastify.post("/get", async (request, reply) => {
        const viewerId = await resolveViewerId(request, reply)
        if (viewerId === null) return
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: { profile_image_url: null, twitter_id: null },
        })
    })
}
