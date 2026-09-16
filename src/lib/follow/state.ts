export type LocalFollowState = 0 | 1 | 2 | 3

export interface LocalFollowEdges {
    /** 我 → 对方 的边（存在时 follow_time 取该边时间） */
    readonly outgoing: { readonly followedAtMs: number } | null
    /** 对方 → 我 的边（存在时 followed_time 取该边时间） */
    readonly incoming: { readonly followedAtMs: number } | null
}

export interface LocalFollowRelation {
    readonly state: LocalFollowState
    readonly followTime: number | null
    readonly followedTime: number | null
}

/**
 * CN 1.8.1 follow_state（F0 冻结）：
 * 0=无关系、1=互相关注、2=我→对方单向关注、3=对方→我单向关注。
 */
export function deriveLocalFollowRelation(edges: LocalFollowEdges): LocalFollowRelation {
    if (edges.outgoing !== null && edges.incoming !== null) {
        return {
            state: 1,
            followTime: edges.outgoing.followedAtMs,
            followedTime: edges.incoming.followedAtMs,
        }
    }
    if (edges.outgoing !== null) {
        return { state: 2, followTime: edges.outgoing.followedAtMs, followedTime: null }
    }
    if (edges.incoming !== null) {
        return { state: 3, followTime: null, followedTime: edges.incoming.followedAtMs }
    }
    return { state: 0, followTime: null, followedTime: null }
}
