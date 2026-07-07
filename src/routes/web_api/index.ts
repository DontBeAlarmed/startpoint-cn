import { FastifyInstance } from "fastify";
import playerApiPlugin from "./player"
import serverApiPlugin from "./server"
import mailApiPlugin from "./mail"
import lookupApiPlugin from "./lookup"

const routes = async (fastify: FastifyInstance) => {
    fastify.register(require('@fastify/multipart'), {
        limits: {
            fieldNameSize: 100, // Max field name size in bytes
            fieldSize: 100,     // Max field value size in bytes
            fields: 10,         // Max number of non-file fields
            fileSize: 5000000,  // For multipart forms, the max file size in bytes
            files: 1,           // Max number of file fields
            headerPairs: 2000,  // Max number of header key=>value pairs
            parts: 1000         // For multipart forms, the max number of parts (fields + files)
        }
    })

    fastify.register(playerApiPlugin, { prefix: "/player" })
    fastify.register(serverApiPlugin, { prefix: "/server" })
    fastify.register(mailApiPlugin, { prefix: "/mail" })
    fastify.register(lookupApiPlugin, { prefix: "/lookup" })
}

export default routes;