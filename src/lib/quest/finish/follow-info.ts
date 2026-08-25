import { getServerTime } from "../../../utils"
import { getRankDegree } from "../../stamina"
import { resolveMultiPlayerContext } from "../../../multi/player-context"
import { getRealNow } from "../../../runtime/time/game-time"

interface FollowInfoPlayer {
    name: string
    rankPoint?: number
    role?: number
    degreeId?: number
}

interface FollowInfoPlayerContext {
    player: FollowInfoPlayer
}

type FollowInfoResolver = (viewerId: number) => Promise<FollowInfoPlayerContext | null>

export async function buildFinishFollowInfo(
    viewerId: number,
    mateResults: Array<{ viewer_id?: number }>,
    fallbackMateIds: number[] = [],
    resolvePlayer: FollowInfoResolver = resolveMultiPlayerContext,
    warn: (message: string) => void = console.warn,
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

        followInfo.push({
            viewer_id: mateViewerId,
            name: mateCtx.player.name,
            last_login_time: getServerTime(getRealNow()),
            rank: getRankDegree(mateCtx.player.rankPoint || 0),
            comment: "",
            role: mateCtx.player.role || 1,
            degree_id: mateCtx.player.degreeId || 1,
            follow_state: 0,
            follow_time: null,
            followed_time: null,
            profile_image_url: null,
        })
    }

    return followInfo
}
