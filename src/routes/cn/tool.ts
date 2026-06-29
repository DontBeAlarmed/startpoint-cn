import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders, generateViewerId } from "../../utils";
import { insertAccountSync, getAccountSync, insertDefaultPlayerSync, getPlayerSync, insertSessionWithToken, updateAccountSync, deleteSession, deleteSessionSync, getDeviceBindingSync, insertDeviceBindingSync, deleteDeviceBindingSync, getSessionByAccountIdSync } from "../../data/wdfpData";
import { SessionType } from "../../data/types";
import { saveAccountDefaultPlayer } from "../../data/activeAccount";

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

function generateLoginToken(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let token = "";
    for (let i = 0; i < 32; i++) {
        token += chars[Math.floor(Math.random() * chars.length)];
    }
    return token;
}

const viewerIdToAccountId = new Map<number, number>();

interface GetHeaderResponseBody {
    viewer_id: number
}

const routes = async (fastify: FastifyInstance) => {
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

    fastify.post("/auth", async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders(),
            data: {}
        });
    });

    fastify.post("/signup", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CnSignupBody;
        const udid = request.headers["udid"] as string || "unknown";
        const shortUdid = 0;
        const deviceId = body.device_id

        const loginToken = generateLoginToken();
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
                updateAccountSync({ id: accountId, lastLoginTime: new Date() })
                // Reuse existing viewer_id if session exists for this account
                const existingSession = getSessionByAccountIdSync(accountId, SessionType.VIEWER)
                if (existingSession) {
                    deleteSessionSync(existingSession.token)
                    viewerId = parseInt(existingSession.token)
                }
            } else {
                // Account was deleted — clean up stale binding and create new account
                deleteDeviceBindingSync(deviceId)
                const account = insertAccountSync({
                    appId: "wf_cn", idpAlias: "", idpCode: "leiting", idpId: "", status: "normal"
                })
                accountId = account.id
                const player = insertDefaultPlayerSync(accountId)
                saveAccountDefaultPlayer(accountId, player.id)
                insertDeviceBindingSync(deviceId, accountId)
            }
        } else {
            // New device → create account
            const account = insertAccountSync({
                appId: "wf_cn", idpAlias: "", idpCode: "leiting", idpId: "", status: "normal"
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
            expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
        });

        viewerIdToAccountId.set(viewerId, accountId);

        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders({
                viewer_id: viewerId,
                short_udid: shortUdid,
                udid: udid,
            }),
            data: {
                login_token: loginToken,
                newAccount: newAccount ? 1 : 0,
                roleName: `Player${accountId}`,
                accountName: `Player${accountId}`,
                sign: "dummy_sign",
                createDate: new Date().toISOString(),
                serverName: "StarPoint CN",
                serverId: 1,
            }
        });
    });
};

export default routes;
