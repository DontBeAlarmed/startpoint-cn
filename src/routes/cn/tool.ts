import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders } from "../../utils";
import { insertAccount, insertDefaultPlayerSync, getAccountPlayers, getPlayerSync, getAccount } from "../../data/wdfpData";

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

        const loginToken = generateLoginToken();

        const account = await insertAccount({
            appId: "wf_cn",
            idpAlias: "",
            idpCode: "leiting",
            idpId: "",
            status: "normal"
        });
        insertDefaultPlayerSync(account.id);

        viewerIdToAccountId.set(account.id, account.id);

        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders({
                viewer_id: account.id,
                short_udid: shortUdid,
                udid: udid,
            }),
            data: {
                login_token: loginToken,
                newAccount: 1,
                roleName: `Player${account.id}`,
                accountName: `Player${account.id}`,
                sign: "dummy_sign",
                createDate: new Date().toISOString(),
                serverName: "StarPoint CN",
                serverId: 1,
            }
        });
    });
};

export default routes;
