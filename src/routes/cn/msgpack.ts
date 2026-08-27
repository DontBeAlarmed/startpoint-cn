import type { FastifyInstance, FastifyReply } from "fastify"
import { pack } from "msgpackr"
import { fixUint32Tags } from "../../lib/msgpack-compat"

type CnMsgpackEncoder = (payload: unknown) => string
type CnMsgpackPendingEncoder = (
    payload: unknown,
    encoder: CnMsgpackEncoder,
) => string
const pendingEncoders = new WeakMap<object, CnMsgpackPendingEncoder>()

export function encodeCnMsgpackPayload(payload: unknown): string {
    return fixUint32Tags(pack(payload)).toString("base64")
}

export function setCnMsgpackPendingEncoder(
    reply: FastifyReply,
    pendingEncoder: CnMsgpackPendingEncoder,
): void {
    pendingEncoders.set(reply, pendingEncoder)
}

export function registerCnMsgpackOnSend(
    fastify: FastifyInstance,
    encoder: CnMsgpackEncoder = encodeCnMsgpackPayload,
): void {
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") !== "application/x-msgpack") {
            pendingEncoders.delete(reply)
            done(null, payload)
            return
        }
        try {
            const pendingEncoder = pendingEncoders.get(reply)
            pendingEncoders.delete(reply)
            const encodedPayload = pendingEncoder
                ? pendingEncoder(payload, encoder)
                : encoder(payload)
            done(null, encodedPayload)
        } catch (error) {
            pendingEncoders.delete(reply)
            done(error as Error)
        }
    })
}
