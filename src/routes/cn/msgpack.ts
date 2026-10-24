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
    // 字节纪律：沿用函数式 pack（恒定 map16 头，客户端验证过的字节风格），
    // 不换 Packr 实例（records/fixmap 差异会全量改写响应字节）。
    // msgpackr 1.12 起 >65535 键 map 会抛错（1.11 自动放宽）——合法游戏
    // 响应远达不到该规模；万一发生，把根因打到 stderr 再上抛（可诊断 500）。
    try {
        return fixUint32Tags(pack(payload)).toString("base64")
    } catch (error) {
        console.error(
            "[msgpack] response encode failed:",
            error instanceof Error ? error.message : error,
        )
        throw error
    }
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
