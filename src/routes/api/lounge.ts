import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { getSession } from "../../data/domains/session"
import { generateDataHeaders } from "../../utils"

// lounge（共斗匹配大厅）家族的入口端点。完整匹配系统未实现——本端点回空
// 列表（= 无可加入的大厅），让客户端 LoungeMatchingProcessingFlow 优雅结束，
// 防止 404 重试循环触发客户端 F 级报错（2026-10-30 真机复现）。
// 家族其余端点（select/share/prepare/search/create/restore）依赖 get_list
// 的非空结果，空列表下不可达，暂不注册。

interface GetListBody {
    viewer_id: number
    use_case: number
    api_count?: number
}

const routes = async (fastify: FastifyInstance): Promise<void> => {
    fastify.post("/get_list", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetListBody
        const viewerId = body.viewer_id
        if (!Number.isSafeInteger(viewerId) || viewerId <= 0) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }
        const session = await getSession(String(viewerId))
        if (session === null) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })
        }
        // use_case 区分匹配用途（共斗特殊交换等）；无匹配系统时恒为空列表
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: { lounge_list: [] },
        })
    })
}

export default routes
