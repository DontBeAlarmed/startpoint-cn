import { getDb } from "../../../data/db"
import { getPlayerSync } from "../../../data/domains/player"
import { getViewerIdSync } from "../../../data/domains/session"
import { getLocalFollowRelationSync } from "../../../data/domains/follow"
import { getPlayerRankLevel } from "../../../lib/player-rank-content"
import type { LocalFollowRelation, LocalFollowState } from "../../../data/domains/follow"

/** F0 冻结的 follow_info / search_result 投影（CN 1.8.1 必填 + Option 字段）。 */
export interface FollowUserProjection {
    readonly viewer_id: number
    readonly name: string
    readonly rank: number
    readonly degree_id: number
    readonly role: number
    readonly comment: string
    readonly last_login_time: number
    readonly last_login_region: string | null
    readonly leader_character_id: number
    readonly leader_character_evolution_img_level: number
    readonly follow_state: LocalFollowState
    readonly follow_time: number | null
    readonly followed_time: number | null
    readonly profile_image_url: string | null
}

function accountPlayerId(playerId: number): number | null {
    const row = getDb().prepare(`
        SELECT account_id FROM players WHERE id = ?
    `).get(playerId) as { account_id: number } | undefined
    return row?.account_id ?? null
}

export function projectFollowUser(
    viewerPlayerId: number,
    targetPlayerId: number,
    relation: LocalFollowRelation,
): FollowUserProjection | null {
    const player = getPlayerSync(targetPlayerId)
    if (player === null) return null
    const accountId = accountPlayerId(targetPlayerId)
    const targetViewerId = accountId === null ? null : getViewerIdSync(accountId)
    if (targetViewerId === null || targetViewerId === 0) return null
    return {
        viewer_id: targetViewerId,
        name: player.name,
        rank: getPlayerRankLevel(player.rankPoint || 0),
        degree_id: player.degreeId || 1,
        role: player.role || 1,
        comment: player.comment ?? "",
        last_login_time: Math.floor(player.lastLoginTime.getTime() / 1000),
        last_login_region: null,
        leader_character_id: player.leaderCharacterId ?? 0,
        leader_character_evolution_img_level: 0,
        follow_state: relation.state,
        follow_time: relation.followTime === null ? null : Math.floor(relation.followTime / 1000),
        followed_time: relation.followedTime === null ? null : Math.floor(relation.followedTime / 1000),
        profile_image_url: null,
    }
}

export function projectRelationFor(
    viewerPlayerId: number,
    targetPlayerId: number,
): FollowUserProjection | null {
    return projectFollowUser(
        viewerPlayerId,
        targetPlayerId,
        getLocalFollowRelationSync(viewerPlayerId, targetPlayerId),
    )
}
