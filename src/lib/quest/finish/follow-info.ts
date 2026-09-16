import { getServerTime } from "../../../utils"
import { getRankDegree } from "../../stamina"
import { resolveMultiPlayerContext } from "../../../multi/player-context"
import { getRealNow } from "../../../runtime/time/game-time"
import {
    getLocalFollowRelationSync,
    type LocalFollowRelation,
} from "../../../data/domains/follow"

interface FollowInfoPlayer {
    name: string
    rankPoint?: number
    role?: number
    degreeId?: number
}

interface FollowInfoPlayerContext {
    player: FollowInfoPlayer
    playerId?: number
}

type FollowInfoResolver = (viewerId: number) => Promise<FollowInfoPlayerContext | null>
type FollowRelationResolver = (
    sourcePlayerId: number,
    targetPlayerId: number,
) => LocalFollowRelation

export async function buildFinishFollowInfo(
    viewerId: number,
    mateResults: Array<{ viewer_id?: number }>,
    fallbackMateIds: number[] = [],
    resolvePlayer: FollowInfoResolver = resolveMultiPlayerContext,
    warn: (message: string) => void = console.warn,
    options: {
        readonly requesterPlayerId?: number
        readonly getRelation?: FollowRelationResolver
    } = {},
) {
    const ids = new Set<number>()
    for (const result of mateResults) {
        const mateViewerId = Number(result?.viewer_id)
        if (Number.isFinite(mateViewerId)) ids.add(mateViewerId)
    }
    for (const mateViewerId of fallbackMateIds) {
        if (Number.isFinite(mateViewerId)) ids.add(Number(mateViewerId))
    }

    const followInfo = []
    for (const mateViewerId of ids) {
        if (mateViewerId === viewerId || mateViewerId >= 900000000) continue

        let mateCtx: FollowInfoPlayerContext | null
        try {
            mateCtx = await resolvePlayer(mateViewerId)
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            warn(`[MULTI] finish follow_info skipped viewer=${mateViewerId}: ${detail}`)
            continue
        }
        if (!mateCtx) continue

        // F5：结算 follow_info 只反映真实本地关系（同节点队友）；
        // 跨节点队友本地不可解析 → 上方 continue 跳过（不投影、不可关注），
        // 绝不继承房间级 establisher_follow=1 兼容值。
        const relation = options.requesterPlayerId !== undefined
            && mateCtx.playerId !== undefined
            && options.getRelation !== undefined
            ? options.getRelation(options.requesterPlayerId, mateCtx.playerId)
            : { state: 0 as const, followTime: null, followedTime: null }
        followInfo.push({
            viewer_id: mateViewerId,
            name: mateCtx.player.name,
            last_login_time: getServerTime(getRealNow()),
            rank: getRankDegree(mateCtx.player.rankPoint || 0),
            comment: "",
            role: mateCtx.player.role || 1,
            degree_id: mateCtx.player.degreeId || 1,
            follow_state: relation.state,
            follow_time: relation.followTime === null
                ? null
                : Math.floor(relation.followTime / 1000),
            followed_time: relation.followedTime === null
                ? null
                : Math.floor(relation.followedTime / 1000),
            profile_image_url: null,
        })
    }

    return followInfo
}
