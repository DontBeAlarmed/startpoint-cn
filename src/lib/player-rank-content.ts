import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../content/runtime/content-snapshot"

type PlayerRankTable = Record<string, unknown[][]>

interface PlayerRankEntry {
    readonly stamina: number
    readonly threshold: number
    readonly healRate: number
}

export interface PlayerRankContent {
    readonly getMaxStamina: (degreeId: number) => number
    readonly getHealRate: (degree: number) => number
    readonly getRankDegree: (rankPoint: number) => number
}

const playerRankContentByTable = new WeakMap<object, PlayerRankContent>()

function parseEntry(degreeText: string, value: unknown[][]): PlayerRankEntry {
    const row = value[0]
    if (!Array.isArray(row)) throw new TypeError(`invalid player rank row: ${degreeText}`)
    const stamina = Number(row[0])
    const threshold = Number(row[1])
    const healRate = Number(row[2])
    if (!Number.isSafeInteger(stamina) || stamina < 0
        || !Number.isSafeInteger(threshold) || threshold < 0
        || !Number.isFinite(healRate) || healRate < 0) {
        throw new TypeError(`invalid player rank entry: ${degreeText}`)
    }
    return { stamina, threshold, healRate }
}

export function parsePlayerRankContent(table: unknown): PlayerRankContent {
    if (!table || typeof table !== "object" || Array.isArray(table)) {
        throw new TypeError("invalid player rank table")
    }
    const cached = playerRankContentByTable.get(table)
    if (cached !== undefined) return cached
    const entries = new Map<number, PlayerRankEntry>()
    for (const [degreeText, value] of Object.entries(table as PlayerRankTable)) {
        const degree = Number(degreeText)
        if (!Number.isSafeInteger(degree) || degree < 0 || entries.has(degree)) {
            throw new TypeError(`invalid player rank degree: ${degreeText}`)
        }
        entries.set(degree, parseEntry(degreeText, value))
    }
    if (!entries.has(1) || !entries.has(250)) {
        throw new TypeError("player rank table is missing required boundary ranks")
    }
    const sortedDegrees = [...entries.keys()].sort((left, right) => left - right)
    const content = Object.freeze({
        getMaxStamina: (degreeId: number): number => {
            const entry = degreeId <= 0
                ? entries.get(1)
                : entries.get(degreeId) ?? entries.get(250)
            if (entry === undefined) throw new TypeError(`unknown player rank: ${degreeId}`)
            return entry.stamina
        },
        getHealRate: (degree: number): number => entries.get(degree)?.healRate ?? 0,
        getRankDegree: (rankPoint: number): number => {
            let result = 1
            for (const degree of sortedDegrees) {
                const entry = entries.get(degree)!
                if (rankPoint >= entry.threshold) result = degree
                else break
            }
            return result
        },
    })
    playerRankContentByTable.set(table, content)
    return content
}

const playerRankContentByRepository = new WeakMap<ReadonlyContentRepository, PlayerRankContent>()

export function getPlayerRankContent(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): PlayerRankContent {
    const cached = playerRankContentByRepository.get(repository)
    if (cached !== undefined) return cached
    const content = parsePlayerRankContent(
        repository.table<PlayerRankTable>("cdndata/player_rank_full.json"),
    )
    playerRankContentByRepository.set(repository, content)
    return content
}

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
