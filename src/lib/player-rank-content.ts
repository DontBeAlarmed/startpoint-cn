import { getContentSnapshot } from "../content/runtime/content-snapshot"

type PlayerRankTable = Record<string, unknown[][]>

export function getPlayerRankLevel(rankPoint: number): number {
    const playerRankTable = getContentSnapshot().repository.table<PlayerRankTable>(
        "cdndata/player_rank.json",
    )
    let level = 1
    for (const [rank, data] of Object.entries(playerRankTable)) {
        const threshold = Number(data?.[0]?.[1])
        if (Number.isFinite(threshold) && rankPoint >= threshold) level = Number(rank)
    }
    return level
}
