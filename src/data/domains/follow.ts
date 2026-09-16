import { getDb } from "../db"
import { getSocialCapacityPolicySync } from "../../lib/config-content"
import {
    deriveLocalFollowRelation,
    type LocalFollowRelation,
} from "../../lib/follow/state"

export { deriveLocalFollowRelation }
export type { LocalFollowRelation, LocalFollowState } from "../../lib/follow/state"

export type AddLocalFollowResult =
    | { readonly ok: true; readonly changed: boolean }
    | { readonly ok: false; readonly reason: "self" | "source_limit" | "target_limit" | "missing_target" }

export type LocalFollowWriteFailureReason =
    | "self"
    | "source_limit"
    | "target_limit"
    | "missing_target"

export type BulkEditLocalFollowsResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: LocalFollowWriteFailureReason }

interface FollowEdgeRow {
    readonly follower_player_id: number
    readonly followed_player_id: number
    readonly followed_at: number
}

function edgeExists(followerPlayerId: number, followedPlayerId: number): FollowEdgeRow | undefined {
    return getDb().prepare(`
        SELECT follower_player_id, followed_player_id, followed_at
        FROM players_follows
        WHERE follower_player_id = ? AND followed_player_id = ?
    `).get(followerPlayerId, followedPlayerId) as FollowEdgeRow | undefined
}

function playerExists(playerId: number): boolean {
    return getDb().prepare(`SELECT 1 FROM players WHERE id = ?`).get(playerId) !== undefined
}

function countOutgoing(sourcePlayerId: number): number {
    return (getDb().prepare(`
        SELECT COUNT(*) AS n FROM players_follows WHERE follower_player_id = ?
    `).get(sourcePlayerId) as { n: number }).n
}

export function countLocalFollowersSync(targetPlayerId: number): number {
    return (getDb().prepare(`
        SELECT COUNT(*) AS n FROM players_follows WHERE followed_player_id = ?
    `).get(targetPlayerId) as { n: number }).n
}

export function getLocalFollowRelationSync(
    sourcePlayerId: number,
    targetPlayerId: number,
): LocalFollowRelation {
    const outgoing = edgeExists(sourcePlayerId, targetPlayerId)
    const incoming = edgeExists(targetPlayerId, sourcePlayerId)
    return deriveLocalFollowRelation({
        outgoing: outgoing === undefined ? null : { followedAtMs: outgoing.followed_at },
        incoming: incoming === undefined ? null : { followedAtMs: incoming.followed_at },
    })
}

/** 我→对方 边的目标列表（关注中，含互关），按关注时间降序。 */
export function listLocalFollowTargetsSync(sourcePlayerId: number): number[] {
    return (getDb().prepare(`
        SELECT followed_player_id AS id FROM players_follows
        WHERE follower_player_id = ?
        ORDER BY followed_at DESC, followed_player_id DESC
    `).all(sourcePlayerId) as Array<{ id: number }>).map(row => row.id)
}

/** 对方→我 边的来源列表（粉丝，含互关），按被关注时间降序。 */
export function listLocalFollowerSourcesSync(targetPlayerId: number): number[] {
    return (getDb().prepare(`
        SELECT follower_player_id AS id FROM players_follows
        WHERE followed_player_id = ?
        ORDER BY followed_at DESC, follower_player_id DESC
    `).all(targetPlayerId) as Array<{ id: number }>).map(row => row.id)
}

function addEdgeWithinTransaction(
    sourcePlayerId: number,
    targetPlayerId: number,
    followedAtMs: number,
): AddLocalFollowResult {
    if (sourcePlayerId === targetPlayerId) return { ok: false, reason: "self" }
    if (!playerExists(targetPlayerId)) return { ok: false, reason: "missing_target" }
    if (edgeExists(sourcePlayerId, targetPlayerId) !== undefined) return { ok: true, changed: false }
    const policy = getSocialCapacityPolicySync()
    if (countOutgoing(sourcePlayerId) >= policy.maxFollows) {
        return { ok: false, reason: "source_limit" }
    }
    if (countLocalFollowersSync(targetPlayerId) >= policy.maxFollowers) {
        return { ok: false, reason: "target_limit" }
    }
    getDb().prepare(`
        INSERT INTO players_follows (follower_player_id, followed_player_id, followed_at)
        VALUES (?, ?, ?)
    `).run(sourcePlayerId, targetPlayerId, followedAtMs)
    return { ok: true, changed: true }
}

export function addLocalFollowSync(input: {
    sourcePlayerId: number
    targetPlayerId: number
    followedAtMs: number
}): AddLocalFollowResult {
    return getDb().transaction(() => addEdgeWithinTransaction(
        input.sourcePlayerId,
        input.targetPlayerId,
        input.followedAtMs,
    ))()
}

export function deleteLocalFollowSync(input: {
    sourcePlayerId: number
    targetPlayerId: number
}): boolean {
    const result = getDb().prepare(`
        DELETE FROM players_follows
        WHERE follower_player_id = ? AND followed_player_id = ?
    `).run(input.sourcePlayerId, input.targetPlayerId)
    return result.changes > 0
}

export function deleteLocalFollowerSync(input: {
    playerId: number
    followerPlayerId: number
}): boolean {
    const result = getDb().prepare(`
        DELETE FROM players_follows
        WHERE follower_player_id = ? AND followed_player_id = ?
    `).run(input.followerPlayerId, input.playerId)
    return result.changes > 0
}

export function bulkEditLocalFollowsSync(input: {
    sourcePlayerId: number
    addTargetPlayerIds: readonly number[]
    deleteTargetPlayerIds: readonly number[]
    followedAtMs: number
}): BulkEditLocalFollowsResult {
    return getDb().transaction((): BulkEditLocalFollowsResult => {
        for (const targetPlayerId of input.deleteTargetPlayerIds) {
            deleteLocalFollowSync({ sourcePlayerId: input.sourcePlayerId, targetPlayerId })
        }
        for (const targetPlayerId of input.addTargetPlayerIds) {
            const added = addEdgeWithinTransaction(
                input.sourcePlayerId,
                targetPlayerId,
                input.followedAtMs,
            )
            if (!added.ok) return { ok: false, reason: added.reason }
        }
        return { ok: true }
    })()
}
