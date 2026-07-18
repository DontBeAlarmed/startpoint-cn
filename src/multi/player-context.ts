import { resolvePlayerIdSync } from "../data/activeAccount"
import { getPlayerSync } from "../data/domains/player"
import { getSession } from "../data/domains/session"
import type { Player } from "../data/types"

export interface MultiPlayerContext {
    playerId: number
    player: Player
}

export interface MultiPlayerContextDependencies {
    getSession: (viewerId: string) => Promise<{ accountId: number } | null>
    resolvePlayerIdSync: (accountId: number) => number | null
    getPlayerSync: (playerId: number) => Player | null
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
