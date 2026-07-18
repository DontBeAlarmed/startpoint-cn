import { generateDataHeaders } from "../utils"

const MAX_INT32 = 2147483647

export interface BoxGachaResetRequest {
    viewerId: number
    boxGachaId: number
    boxId: number
}

interface ProtocolReply {
    header(name: string, value: string): ProtocolReply
    status(statusCode: number): ProtocolReply
    send(payload: unknown): unknown
}

export function parseBoxGachaResetRequest(body: unknown): BoxGachaResetRequest | null {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null

    const record = body as Record<string, unknown>
    const viewerId = record.viewer_id
    const boxGachaId = record.box_gacha_id
    const boxId = record.box_id
    if (
        !Number.isInteger(viewerId)
        || !Number.isInteger(boxGachaId)
        || !Number.isInteger(boxId)
        || (viewerId as number) < 1
        || (boxGachaId as number) < 1
        || (boxId as number) < 1
        || (viewerId as number) > MAX_INT32
        || (boxGachaId as number) > MAX_INT32
        || (boxId as number) > MAX_INT32
    ) return null

    return {
        viewerId: viewerId as number,
        boxGachaId: boxGachaId as number,
        boxId: boxId as number,
    }
}

export function sendBoxGachaResultCode(
    reply: ProtocolReply,
    viewerId: number,
    resultCode: number,
): unknown {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        data_headers: generateDataHeaders({
            viewer_id: viewerId,
            result_code: resultCode,
        }),
        data: {},
    })
}
