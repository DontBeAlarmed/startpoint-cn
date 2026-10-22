import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SessionType } from "../../data/types";
import { generateViewerIdSession, getAccountSessionsOfType, getSession } from "../../data/domains/session"
import { getPlayerFromAccountIdSync, insertDefaultPlayerSync } from "../../data/domains/player"
import { bumpEconomyGenerationForPlayer } from "../../lib/economy-response-cache";
import { generateDataHeaders } from "../../utils";

interface GetHeaderResponseBody {
    viewer_id: number
}

interface SignupBody {
    app_secret: string
    access_token: string
    storage_directory_path: string
    app_admin: string
    kakao_pid: string,
    device_id: number,
    idp_code: string
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/get_header_response", (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetHeaderResponseBody

        reply.header("content-type", "application/x-msgpack")

        reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: body.viewer_id
            }),
            "data": []
        })
    })

    fastify.post("/signup", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SignupBody
        
        const zat = body.access_token
        if (!zat) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const udid = request.headers['udid']
        if (!udid) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid headers."
        })

        const session = await getSession(zat)
        if (session === null || session.type !== SessionType.ZAT) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid zat provided."
        })

        const accountId = session.accountId

        // Create the player data if it doesn't exist.
        const accountPlayer = getPlayerFromAccountIdSync(accountId)
        if (accountPlayer === null) {    
            // create new player account
            insertDefaultPlayerSync(accountId)
        }

        // generate viewer id
        const viewerIds = await getAccountSessionsOfType(accountId, SessionType.VIEWER)
        const viewerId = !viewerIds[0] ? await generateViewerIdSession(accountId) : viewerIds[0]

        // 新登录会话：推进经济幂等世代（R-F02，与 cn/tool.ts 对称）——客户端
        // api_count 回标题归零，重登后同计数请求不得回放旧会话响应
        const signupPlayer = getPlayerFromAccountIdSync(accountId)
        if (signupPlayer !== null) {
            bumpEconomyGenerationForPlayer(signupPlayer.id)
        }

        reply.header("content-type", "application/x-msgpack")
        reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: Number.parseInt(viewerId.token),
                udid: String(udid)
            }, ['short_udid', 'viewer_id', 'udid', 'servertime', 'result_code']),
            "data": []
        })
    })
}

export default routes;