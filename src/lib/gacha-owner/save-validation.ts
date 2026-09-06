import {
    getGachaCatalog,
    parseGachaJstTimestamp,
    type GachaCatalog,
} from "../gacha-catalog"

type SaveRow = Readonly<Record<string, unknown>>

function safeInteger(value: unknown, field: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new Error(`Invalid Gacha save ${field}`)
    }
    return value as number
}

function nullableCount(value: unknown, field: string): number | null {
    return value === null ? null : safeInteger(value, field)
}

function unixMilliseconds(value: unknown, field: string): number {
    const seconds = safeInteger(value, field)
    const milliseconds = seconds * 1000
    if (!Number.isSafeInteger(milliseconds)) throw new Error(`Invalid Gacha save ${field}`)
    return milliseconds
}

export function assertValidGachaSaveState(tables: ReadonlyMap<
    string,
    readonly SaveRow[]
>, suppliedCatalog?: GachaCatalog): void {
    const parentRows = tables.get("players_gacha_info") ?? []
    const parentIds = new Set(parentRows.map(row => (
        safeInteger(row.gacha_id, "players_gacha_info.gacha_id", 1)
    )))
    for (const row of parentRows) {
        if (row.crazy_draw_count !== null && row.crazy_draw_count !== undefined) {
            safeInteger(row.crazy_draw_count, "players_gacha_info.crazy_draw_count")
        }
    }
    const hasContentBoundGachaState = (tables.get("players_gacha_details") ?? []).some(row => (
        (row.comeback_period_start_time !== null
            && row.comeback_period_start_time !== undefined)
        || (row.comeback_period_end_time !== null
            && row.comeback_period_end_time !== undefined)
    ))
        || (tables.get("players_stars_gacha_campaigns")?.length ?? 0) > 0
        || (tables.get("players_gacha_crazy_results")?.length ?? 0) > 0
    const catalog = hasContentBoundGachaState
        ? suppliedCatalog ?? getGachaCatalog()
        : null

    for (const row of tables.get("players_gacha_details") ?? []) {
        const gachaId = safeInteger(row.gacha_id, "players_gacha_details.gacha_id", 1)
        if (!parentIds.has(gachaId)) throw new Error(`Gacha detail ${gachaId} has no parent info`)
        nullableCount(row.daily_one_count, "players_gacha_details.daily_one_count")
        nullableCount(row.daily_ten_count, "players_gacha_details.daily_ten_count")
        const start = row.comeback_period_start_time
        const end = row.comeback_period_end_time
        if ((start === null) !== (end === null)) {
            throw new Error(`Gacha detail ${gachaId} has a partial Comeback period`)
        }
        if (start !== null) {
            const startMs = unixMilliseconds(start, "players_gacha_details.comeback_period_start_time")
            const endMs = unixMilliseconds(end, "players_gacha_details.comeback_period_end_time")
            if (startMs > endMs
                || catalog?.banners[String(gachaId)]?.definition.isComeback !== true) {
                throw new Error(`Gacha detail ${gachaId} has an invalid Comeback period`)
            }
        }
    }

    for (const row of tables.get("players_stars_gacha_campaigns") ?? []) {
        const campaignId = safeInteger(
            row.campaign_id,
            "players_stars_gacha_campaigns.campaign_id",
            1,
        )
        const gachaId = safeInteger(row.gacha_id, "players_stars_gacha_campaigns.gacha_id", 1)
        if (!parentIds.has(gachaId)) throw new Error(`Stars Gacha ${gachaId} has no parent info`)
        const campaign = catalog?.starsCampaigns[String(campaignId)]
        const banner = catalog?.banners[String(gachaId)]
        if (campaign === undefined || campaign.gachaId !== gachaId
            || banner?.definition.isStarsGacha !== true) {
            throw new Error(`Stars campaign ${campaignId} does not match Gacha ${gachaId}`)
        }
        const startMs = unixMilliseconds(
            row.period_start_time,
            "players_stars_gacha_campaigns.period_start_time",
        )
        const endMs = unixMilliseconds(
            row.period_end_time,
            "players_stars_gacha_campaigns.period_end_time",
        )
        const freeOneTimes = safeInteger(
            row.free_one_times,
            "players_stars_gacha_campaigns.free_one_times",
        )
        const freeTenTimes = safeInteger(
            row.free_ten_times,
            "players_stars_gacha_campaigns.free_ten_times",
        )
        if (startMs > endMs
            || startMs < parseGachaJstTimestamp(campaign.availableFrom)
            || endMs > parseGachaJstTimestamp(campaign.availableUntil)
            || freeOneTimes > campaign.maximumFreeGachaTimes
            || freeTenTimes > campaign.maximumFreeGachaTimes) {
            throw new Error(`Stars campaign ${campaignId} state exceeds its Content limits`)
        }
    }

    const crazyPositions = new Map<string, Set<number>>()
    const crazyCandidateIds = new Map<number, ReadonlySet<number>>()
    for (const row of tables.get("players_gacha_crazy_results") ?? []) {
        const gachaId = safeInteger(row.gacha_id, "players_gacha_crazy_results.gacha_id", 1)
        const slot = safeInteger(row.slot_index, "players_gacha_crazy_results.slot_index")
        const position = safeInteger(row.position, "players_gacha_crazy_results.position")
        const characterId = safeInteger(
            row.character_id,
            "players_gacha_crazy_results.character_id",
            1,
        )
        const banner = catalog?.banners[String(gachaId)]
        if (!parentIds.has(gachaId)
            || banner?.kind !== "character"
            || banner.definition.page.kind !== 5
            || slot > 2
            || position > 9) {
            throw new Error(`Crazy Gacha result ${gachaId}/${slot}/${position} is invalid`)
        }
        let candidateIds = crazyCandidateIds.get(gachaId)
        if (candidateIds === undefined) {
            candidateIds = new Set(Object.values(banner.poolsByRank)
                .flatMap(pool => pool.items.map(item => item.id)))
            crazyCandidateIds.set(gachaId, candidateIds)
        }
        if (!candidateIds.has(characterId)) {
            throw new Error(`Crazy Gacha result ${gachaId} contains Character ${characterId} outside its pools`)
        }
        const key = `${gachaId}:${slot}`
        const positions = crazyPositions.get(key) ?? new Set<number>()
        if (positions.has(position)) throw new Error(`Crazy Gacha result ${key} repeats a position`)
        positions.add(position)
        crazyPositions.set(key, positions)
        if (slot === 0) {
            if (typeof row.movie_id !== "string" || row.movie_id.length === 0) {
                throw new Error(`Crazy Gacha result ${key} has no movie`)
            }
            safeInteger(row.seed, "players_gacha_crazy_results.seed")
            safeInteger(row.entry_count, "players_gacha_crazy_results.entry_count", 1)
            if ((row.ex_boost_item_id === null) !== (row.ex_boost_item_count === null)) {
                throw new Error(`Crazy Gacha result ${key} has partial EX Boost metadata`)
            }
            if (row.ex_boost_item_id !== null) {
                safeInteger(
                    row.ex_boost_item_id,
                    "players_gacha_crazy_results.ex_boost_item_id",
                    1,
                )
                safeInteger(
                    row.ex_boost_item_count,
                    "players_gacha_crazy_results.ex_boost_item_count",
                )
            }
        } else if (row.movie_id !== null || row.seed !== null || row.entry_count !== null
            || row.ex_boost_item_id !== null || row.ex_boost_item_count !== null) {
            throw new Error(`Crazy Gacha saved result ${key} contains display metadata`)
        }
    }
    for (const [key, positions] of crazyPositions) {
        if (positions.size !== 10 || [...positions].some(position => position < 0 || position > 9)) {
            throw new Error(`Crazy Gacha result ${key} is incomplete`)
        }
    }

    for (const row of tables.get("players_gacha_conversions") ?? []) {
        const gachaId = safeInteger(row.gacha_id, "players_gacha_conversions.gacha_id", 1)
        // conversion 是 lifecycle 终态记录：banner 可能已从当前内容快照移除
        // （转换触发本身允许 banner 缺失），只要求 players_gacha_info 父行存在。
        if (!parentIds.has(gachaId)) {
            throw new Error(`Gacha conversion ${gachaId} has no valid parent`)
        }
        safeInteger(row.pending_point, "players_gacha_conversions.pending_point", 1)
        safeInteger(row.converted_at, "players_gacha_conversions.converted_at")
        const shown = safeInteger(row.shown, "players_gacha_conversions.shown")
        if (shown > 1) throw new Error(`Gacha conversion ${gachaId} shown state is invalid`)
    }
}
