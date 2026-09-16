import type { FastifyInstance } from "fastify"
import { registerFollowReadRoutes } from "./follow/read-routes"
import { registerFollowWriteRoutes } from "./follow/write-routes"

/**
 * CN 1.8.1 Follow 协议（F0 冻结契约）：同服有向边持久化（F1 owner）驱动
 * lists/search_id 读投影与 add/delete/delete_followed/bulk_edit 写端点。
 * search_twitter 与 SNS 绑定不在范围；跨服目标不可解析（本地 session 边界）。
 */
const routes = async (fastify: FastifyInstance) => {
    registerFollowReadRoutes(fastify)
    registerFollowWriteRoutes(fastify)
}

export default routes
