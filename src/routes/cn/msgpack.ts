import type { FastifyInstance, FastifyReply } from "fastify"
import { pack } from "msgpackr"
import { fixUint32Tags } from "../../lib/msgpack-compat"

type CnMsgpackEncoder = (payload: unknown) => string
const pendingCommits = new WeakMap<object, () => void>()

export function encodeCnMsgpackPayload(payload: unknown): string {
    return fixUint32Tags(pack(payload)).toString("base64")
}

export function setCnMsgpackPendingCommit(
    reply: FastifyReply,
    commit: () => void,
): void {
    pendingCommits.set(reply, commit)
}

export function registerCnMsgpackOnSend(
    fastify: FastifyInstance,
    encoder: CnMsgpackEncoder = encodeCnMsgpackPayload,
): void {
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") !== "application/x-msgpack") {
            pendingCommits.delete(reply)
            done(null, payload)
            return
        }
        try {
            const encodedPayload = encoder(payload)
            const commit = pendingCommits.get(reply)
            pendingCommits.delete(reply)
            commit?.()
            done(null, encodedPayload)
        } catch (error) {
            pendingCommits.delete(reply)
            done(error as Error)
        }
    })
}
