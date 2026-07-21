import type { FastifyInstance } from "fastify"
import { pack } from "msgpackr"
import { fixUint32Tags } from "../../lib/msgpack-compat"

export function encodeCnMsgpackPayload(payload: unknown): string {
    return fixUint32Tags(pack(payload)).toString("base64")
}

export function registerCnMsgpackOnSend(fastify: FastifyInstance): void {
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") !== "application/x-msgpack") {
            done(null, payload)
            return
        }
        try {
            done(null, encodeCnMsgpackPayload(payload))
        } catch (error) {
            done(error as Error)
        }
    })
}
