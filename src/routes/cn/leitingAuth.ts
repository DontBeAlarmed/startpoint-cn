import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders } from "../../utils";

interface LoginBody {
    userId: string;
    game: string;
    channelNo: string;
    token: string;
    media?: string;
    imei?: string;
    androidId?: string;
    oaid?: string;
    mac?: string;
    terminInfo?: string;
    osVer?: string;
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/channels/channel_leiting/leiting_login",
        async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as LoginBody;

        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders(),
            data: {
                status: "success",
                userId: body.userId,
                data: {
                    idCard: "123456",
                    age: 18,
                    isGuest: 0,
                    auth: 1
                },
                online_server_check: true,
                heart_beat_interval: 240
            }
        });
    });

    fastify.post("/channels/channel_leiting/leiting_antiaddiction_login",
        async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders(),
            data: {
                status: 0,
                message: "success",
                data: {
                    onlineTime: 0,
                    limitTime: 999999,
                    usableTime: 999999
                }
            }
        });
    });

    fastify.post("/channels/channel_leiting/leiting_antiaddiction_logout",
        async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders(),
            data: {}
        });
    });

    fastify.post("/channels/channel_leiting/leiting_update",
        async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders(),
            data: {}
        });
    });
};

export default routes;
