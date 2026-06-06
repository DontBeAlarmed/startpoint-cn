import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const CN_API_HOST = "shijtswygamegf.leiting.com";

const versionData = [
    "// 用于官服正式用",
    JSON.stringify({
        "default": {
            "apiPath": CN_API_HOST,
        },
    })
].join("\r\n");

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/shijtswy/version/client_release_android.dis",
        async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "text/plain; charset=utf-8");
        reply.status(200).send(versionData);
    });

    fastify.get("/shijtswy/version/client_release_ios.dis",
        async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "text/plain; charset=utf-8");
        reply.status(200).send(versionData);
    });
};

export default routes;
