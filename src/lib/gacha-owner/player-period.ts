import { getDb } from "../../data/db"
import {
    getPlayerGachaDetailSync,
    getPlayerStarsGachaCampaignByGachaSync,
    upsertPlayerComebackGachaPeriodSync,
    upsertPlayerStarsGachaCampaignSync,
} from "../../data/domains/gacha-state"
import { getGachaCatalog, parseGachaJstTimestamp } from "../gacha-catalog"
import type { GachaBanner, GachaPeriod } from "../gacha-catalog"
import type { PlayerStarsGachaCampaign } from "../../data/types"

function jstMasterTimestamp(unixSeconds: number): string {
    if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0) {
        throw new TypeError("Gacha player period must be a non-negative Unix timestamp")
    }
    return new Date(unixSeconds * 1000 + 9 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ")
}

function period(startTime: number, endTime: number): GachaPeriod {
    return {
        availableFrom: jstMasterTimestamp(startTime),
        availableUntil: jstMasterTimestamp(endTime),
    }
}

export interface PlayerGachaExecutionState {
    readonly effectivePeriod?: GachaPeriod
    readonly starsCampaign?: Readonly<PlayerStarsGachaCampaign>
}

export function getPlayerGachaExecutionStateSync(
    playerId: number,
    banner: GachaBanner,
): PlayerGachaExecutionState {
    if (banner.definition.isComeback) {
        const detail = getPlayerGachaDetailSync(playerId, banner.gachaId)
        if (detail?.comebackPeriodStartTime === null
            || detail?.comebackPeriodStartTime === undefined
            || detail.comebackPeriodEndTime === null) return {}
        return { effectivePeriod: period(
            detail.comebackPeriodStartTime,
            detail.comebackPeriodEndTime,
        ) }
    }
    if (banner.definition.isStarsGacha) {
        const stars = getPlayerStarsGachaCampaignByGachaSync(playerId, banner.gachaId)
        return stars === null ? {} : {
            effectivePeriod: period(stars.periodStartTime, stars.periodEndTime),
            starsCampaign: stars,
        }
    }
    return {}
}

function runStateGrant(operation: () => void): void {
    if (getDb().inTransaction) operation()
    else getDb().transaction(operation)()
}

export function grantPlayerComebackGachaPeriodSync(input: {
    readonly playerId: number
    readonly gachaId: number
    readonly periodStartTime: number
    readonly periodEndTime: number
}): void {
    const banner = getGachaCatalog().banners[String(input.gachaId)]
    if (banner === undefined || !banner.definition.isComeback) {
        throw new TypeError("Comeback period requires a Comeback Gacha")
    }
    if (input.periodStartTime > input.periodEndTime) throw new TypeError("Comeback period is reversed")
    runStateGrant(() => upsertPlayerComebackGachaPeriodSync(input))
}

export function grantPlayerStarsGachaCampaignSync(input: {
    readonly playerId: number
    readonly campaignId: number
    readonly gachaId: number
    readonly periodStartTime: number
    readonly periodEndTime: number
    readonly freeOneTimes: number
    readonly freeTenTimes: number
}): void {
    const catalog = getGachaCatalog()
    const campaign = catalog.starsCampaigns[String(input.campaignId)]
    const banner = catalog.banners[String(input.gachaId)]
    if (campaign === undefined || campaign.gachaId !== input.gachaId
        || banner === undefined || !banner.definition.isStarsGacha) {
        throw new TypeError("Stars state does not match the Stars Gacha catalog")
    }
    const startMs = input.periodStartTime * 1000
    const endMs = input.periodEndTime * 1000
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)
        || startMs > endMs
        || startMs < parseGachaJstTimestamp(campaign.availableFrom)
        || endMs > parseGachaJstTimestamp(campaign.availableUntil)
        || input.freeOneTimes > campaign.maximumFreeGachaTimes
        || input.freeTenTimes > campaign.maximumFreeGachaTimes) {
        throw new TypeError("Stars state is outside its catalog limits")
    }
    runStateGrant(() => upsertPlayerStarsGachaCampaignSync(input))
}
