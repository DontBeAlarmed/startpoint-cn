import { isIP } from "node:net"
import type { FastifyReply, FastifyRequest } from "fastify"

const FULL_IPV6_LOOPBACK = "0:0:0:0:0:0:0:1"

export function isLoopbackAddress(address: string | null | undefined): boolean {
    if (address === null || address === undefined) return false
    const normalized = address.trim().toLowerCase()
    if (normalized === "::1" || normalized === FULL_IPV6_LOOPBACK) return true

    const ipv4 = normalized.startsWith("::ffff:")
        ? normalized.slice("::ffff:".length)
        : normalized
    if (isIP(ipv4) !== 4) return false
    return ipv4.startsWith("127.")
}

export function requireLoopback(request: FastifyRequest, reply: FastifyReply): boolean {
    if (isLoopbackAddress(request.raw.socket.remoteAddress)) return true
    reply.status(403).send({
        error: "Forbidden",
        code: "LOCAL_MANAGEMENT_ONLY",
        message: "This management operation requires a loopback request",
    })
    return false
}
