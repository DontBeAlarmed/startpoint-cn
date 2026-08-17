import { getPlayerSync } from "../../../data/domains/player"
import { getSession } from "../../../data/domains/session"
import { resolvePlayerIdSync } from "../../../data/activeAccount"
import type { Player } from "../../../data/types"

export interface SessionIdentityDependencies {
    getSession(viewerId: string): Promise<{ accountId: number } | null>
    resolvePlayerId(accountId: number): number | null | undefined
}

const sessionIdentityDependencies: SessionIdentityDependencies = {
    getSession,
    resolvePlayerId: resolvePlayerIdSync,
}

export async function validateSessionIdentity(
    viewerId: number,
    dependencies: SessionIdentityDependencies = sessionIdentityDependencies,
): Promise<{
    accountId: number
    playerId: number
} | null> {
    if (!viewerId || isNaN(viewerId)) return null
    const session = await dependencies.getSession(String(viewerId))
    if (!session) return null
    const playerId = dependencies.resolvePlayerId(session.accountId)
    if (!playerId) return null
    return { accountId: session.accountId, playerId }
}

export async function validateSessionAndPlayer(viewerId: number): Promise<{
    playerId: number
    playerData: Player
} | null> {
    const identity = await validateSessionIdentity(viewerId)
    if (!identity) return null
    const { playerId } = identity
    const playerData = getPlayerSync(playerId)
    if (!playerData) return null
    return { playerId, playerData }
}
