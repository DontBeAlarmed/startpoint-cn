import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders, generateViewerId } from "../../utils";
import { deleteAccountSessionsOfTypeSync, deleteDeviceBindingSync, getAccountSessionsOfTypeSync, getDeviceBindingSync, insertDeviceBindingSync, insertSessionWithToken } from "../../data/domains/session"
import { getAccountSync, insertAccountSync, updateAccountSync } from "../../data/domains/account"
import { insertDefaultPlayerSync } from "../../data/domains/player"
import { SessionType } from "../../data/types";
import { saveAccountDefaultPlayer, resolvePlayerIdSync } from "../../data/activeAccount";
import { createRateLimiter, enforceRateLimit, rateLimitRule } from "../../lib/rate-limit";
import { bumpEconomyGenerationForPlayer } from "../../lib/economy-response-cache";
import { getAccountIdentityProvider } from "../../lib/account-identity-provider";
import { isGiftCodeEnabledSync } from "../../lib/gift-code/capability";
import { getRealNow, getRealNowMs } from "../../runtime/time/game-time";

interface CnSignupBody {
    device_id: number;
    channelNo: string;
    media?: string;
    androidId?: string;
    oaid?: string;
    mac?: string;
    terminInfo?: string;
    osVer?: string;
    storage_directory_path?: string;
    first_viewer_id?: number;
    advertise_id?: string;
}

interface GetHeaderResponseBody {
    viewer_id: number
}

const routes = async (fastify: FastifyInstance) => {
    const identityProvider = getAccountIdentityProvider()
    fastify.post("/get_header_response", (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetHeaderResponseBody;
        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: body.viewer_id
            }),
            "data": []
        });
    });

    fastify.post("/check_enable_gift", async (_request, reply) => {
        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders(),
            data: { enable_gift: isGiftCodeEnabledSync() },
        });
    });

    fastify.post("/auth", async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders(),
            data: {}
        });
    });

    const signupRateLimiter = createRateLimiter(rateLimitRule("SIGNUP", 10))
    fastify.post("/signup", {
        preHandler: (request, reply) => enforceRateLimit(request, reply, signupRateLimiter),
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CnSignupBody;
        const udid = request.headers["udid"] as string || "unknown";
        const shortUdid = 0;
        const deviceId = body.device_id

        let accountId: number;
        let newAccount = true;
        let viewerId: number | undefined;   // set when reusing existing session

        if (!deviceId) {
            return reply.status(400).send({ error: "Missing device_id" })
        }

        // Device binding: each device gets its own account
        const binding = getDeviceBindingSync(deviceId)

        if (binding) {
            // Known device — verify account still exists
            const accountExists = getAccountSync(binding.account_id)
            if (accountExists) {
                accountId = binding.account_id
                newAccount = false
                updateAccountSync({ id: accountId, lastLoginTime: getRealNow() })
                // Clean all old sessions for this account, reuse first token
                const sessions = getAccountSessionsOfTypeSync(accountId, SessionType.VIEWER)
                if (sessions.length > 0) {
                    viewerId = parseInt(sessions[0].token)
                    deleteAccountSessionsOfTypeSync(accountId, SessionType.VIEWER)
                }
            } else {
                // Account was deleted — clean up stale binding and create new account
                deleteDeviceBindingSync(deviceId)
                const identity = identityProvider.resolveCnSignup({ appId: "wf_cn" })
                const account = insertAccountSync({
                    appId: "wf_cn", ...identity, status: "normal"
                })
                accountId = account.id
                const player = insertDefaultPlayerSync(accountId)
                saveAccountDefaultPlayer(accountId, player.id)
                insertDeviceBindingSync(deviceId, accountId)
            }
        } else {
            // New device → create account
            const identity = identityProvider.resolveCnSignup({ appId: "wf_cn" })
            const account = insertAccountSync({
                appId: "wf_cn", ...identity, status: "normal"
            })
            accountId = account.id
            const player = insertDefaultPlayerSync(accountId)
            saveAccountDefaultPlayer(accountId, player.id)
            insertDeviceBindingSync(deviceId, accountId)
        }

        if (!viewerId) {
            viewerId = generateViewerId()
        }
        await insertSessionWithToken({
            token: String(viewerId),
            accountId: accountId,
            type: SessionType.VIEWER,
            expires: new Date(getRealNowMs() + 365 * 24 * 60 * 60 * 1000)
        });

        // 新登录会话：推进经济幂等世代——客户端 api_count 回标题归零，重登后
        // 同计数请求不得回放旧会话响应（跨会话误回放=静默跳过业务执行）
        const signupPlayerId = resolvePlayerIdSync(accountId)
        if (signupPlayerId !== null) {
            bumpEconomyGenerationForPlayer(signupPlayerId)
        }

        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders({
                viewer_id: viewerId,
                short_udid: shortUdid,
                udid: udid,
            }),
            data: {
                newAccount: newAccount ? 1 : 0,
                roleName: `Player${accountId}`,
                accountName: `Player${accountId}`,
                sign: "dummy_sign",
                createDate: getRealNow().toISOString(),
                serverName: "StarPoint CN",
                serverId: 1,
            }
        });
    });
};

export default routes;
