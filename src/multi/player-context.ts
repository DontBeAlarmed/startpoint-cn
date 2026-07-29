import { resolvePlayerIdSync } from "../data/activeAccount"
import { getPlayerSync } from "../data/domains/player"
import { getSession } from "../data/domains/session"
import type { Player } from "../data/types"

const playerRankTable = require("../../assets/cdndata/player_rank.json")

export interface MultiPlayerContext {
    playerId: number
    player: Player
}

export interface MultiPlayerContextDependencies {
    getSession: (viewerId: string) => Promise<{ accountId: number } | null>
    resolvePlayerIdSync: (accountId: number) => number | null
    getPlayerSync: (playerId: number) => Player | null
}

export function getPlayerRankLevel(rankPoint: number): number {
    let level = 1
    for (const [rank, data] of Object.entries(playerRankTable as Record<string, any>)) {
        const threshold = Number(data?.[0]?.[1])
        if (Number.isFinite(threshold) && rankPoint >= threshold) level = Number(rank)
    }
    return level
}

export async function resolveMultiPlayerContext(
    viewerId: number,
    dependencies: Partial<MultiPlayerContextDependencies> = {},
): Promise<MultiPlayerContext | null> {
    const session = await (dependencies.getSession ?? getSession)(viewerId.toString())
    if (!session) return null

    const playerId = (dependencies.resolvePlayerIdSync ?? resolvePlayerIdSync)(session.accountId)
    if (!playerId) return null

    const player = (dependencies.getPlayerSync ?? getPlayerSync)(playerId)
    if (!player) return null

    return { playerId, player }
}
