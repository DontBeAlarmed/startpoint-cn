import { REMOTE_PENDING_NODE_SESSION_ID, type ParticipantIdentity } from "./coordinator/contracts"
import {
    getLocalFollowRelationSync,
    type LocalFollowRelation,
    type LocalFollowState,
} from "../data/domains/follow"

/**
 * F3/F0 冻结的房间关注投影信任链：跨服判定只接受 Coordinator 提供的
 * nodeSessionId（非空且非 remote-pending）；同节点读真实关系，可信跨节点
 * 固定投影 establisher_follow=1（CN 客户端兼容：免费体力 + 互关图标），
 * 不可信身份 fail-closed 为 0。禁止 IP/URL/裸 viewer 推断。
 */
function isTrustedNodeSessionId(nodeSessionId: string): boolean {
    return nodeSessionId !== "" && nodeSessionId !== REMOTE_PENDING_NODE_SESSION_ID
}

export function isTrustedCrossServerGuest(input: {
    readonly requester: ParticipantIdentity
    readonly host: ParticipantIdentity
}): boolean {
    return isTrustedNodeSessionId(input.requester.nodeSessionId)
        && isTrustedNodeSessionId(input.host.nodeSessionId)
        && input.requester.nodeSessionId !== input.host.nodeSessionId
}

export function resolveRoomEstablisherFollowStateSync(input: {
    readonly requester: ParticipantIdentity
    readonly host: ParticipantIdentity
    readonly requesterPlayerId: number
    readonly hostPlayerId: number | null
    readonly getRelation?: (
        sourcePlayerId: number,
        targetPlayerId: number,
    ) => LocalFollowRelation
}): LocalFollowState {
    if (isTrustedCrossServerGuest(input)) return 1
    if (input.requester.nodeSessionId !== input.host.nodeSessionId) return 0
    if (!isTrustedNodeSessionId(input.requester.nodeSessionId)) return 0
    if (input.hostPlayerId === null) return 0
    const getRelation = input.getRelation ?? getLocalFollowRelationSync
    return getRelation(input.requesterPlayerId, input.hostPlayerId).state
}

/**
 * 轻量房间路由用：关系读取失败（如纯内存测试桩无数据库）时 fail-closed 为 0，
 * 与“不可信/未解析 → 无加成”语义一致。开战计费路径不走此包装（成本必须权威）。
 */
export function resolveRoomEstablisherFollowStateSafeSync(input: Parameters<
    typeof resolveRoomEstablisherFollowStateSync
>[0]): LocalFollowState {
    try {
        return resolveRoomEstablisherFollowStateSync(input)
    } catch {
        return 0
    }
}
