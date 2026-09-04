import bundledGachas from "../../../assets/gacha.json"
import bundledStarsCampaigns from "../../../assets/stars_gacha_campaign.json"
import { getRuntimeContentTableSync } from "../../content/runtime/table-access"
import type {
    GachaRuntimeBanners,
    StarsGachaCampaignDefinition,
} from "../types"
import { parseGachaJstTimestamp } from "../gacha-catalog"

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
>): void {
    const gachas = getRuntimeContentTableSync(
        "gacha.json",
        bundledGachas as GachaRuntimeBanners,
    )
    const starsCampaigns = getRuntimeContentTableSync(
        "stars_gacha_campaign.json",
        bundledStarsCampaigns as Readonly<Record<string, StarsGachaCampaignDefinition>>,
    )
    const parentIds = new Set((tables.get("players_gacha_info") ?? []).map(row => (
        safeInteger(row.gacha_id, "players_gacha_info.gacha_id", 1)
    )))

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
            if (startMs > endMs || gachas[String(gachaId)]?.isComeback !== true) {
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
        const campaign = starsCampaigns[String(campaignId)]
        const banner = gachas[String(gachaId)]
        if (campaign === undefined || campaign.gachaId !== gachaId || banner?.isStarsGacha !== true) {
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
}
