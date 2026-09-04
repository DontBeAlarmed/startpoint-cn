import {
    GACHA_EXEC_TYPES,
    GACHA_PAGE_KINDS,
    GACHA_PAYMENT_TYPES,
    isGachaExecAllowed,
    isGachaExecCountAllowed,
} from "../gacha-rules"
import type { GachaCampaignDefinition } from "../types/gacha"
import { getGachaTicketCost, type GachaTicketCost } from "../gacha-ticket"
import { resolveGachaCampaign } from "./catalog"
import type { GachaBanner, GachaCatalog, GachaPeriod } from "./model"
import { GachaPeriodError, isGachaPeriodAvailable } from "./period"

export class GachaRequestError extends Error {}
export class GachaCampaignPeriodError extends Error {
    readonly resultCode = 1361
}

export interface PrepareGachaExecRequestInput {
    readonly catalog: GachaCatalog
    readonly gachaId: number
    readonly paymentType: number
    readonly execType: number
    readonly numberOfExec: number
    readonly nowMs: number
    readonly playerEffectivePeriod?: GachaPeriod
    readonly hasApplicableTicket?: boolean
}

export interface PreparedGachaExecRequest {
    readonly kind: "ordinary" | "crazyCandidate"
    readonly banner: GachaBanner
    readonly effectivePeriod: GachaPeriod
    readonly campaign: Readonly<GachaCampaignDefinition> | null
    readonly ticket: Readonly<GachaTicketCost> | null
}

function effectiveBasePeriod(
    banner: GachaBanner,
    playerPeriod: GachaPeriod | undefined,
): GachaPeriod {
    if (!banner.definition.isComeback && !banner.definition.isStarsGacha) return banner.basePeriod
    if (playerPeriod === undefined) {
        throw new GachaPeriodError("Gacha requires a player-specific period.")
    }
    return playerPeriod
}

export function prepareGachaExecRequest(
    input: PrepareGachaExecRequestInput,
): PreparedGachaExecRequest {
    if (!Number.isSafeInteger(input.gachaId) || input.gachaId <= 0) {
        throw new GachaRequestError("Gacha id is invalid.")
    }
    const banner = input.catalog.banners[String(input.gachaId)]
    if (banner === undefined) throw new GachaRequestError("Gacha does not exist.")
    if (!isGachaExecAllowed(banner.definition, input.paymentType, input.execType)
        || !isGachaExecCountAllowed(input.execType, input.numberOfExec)) {
        throw new GachaRequestError("Gacha execution request is not allowed.")
    }
    const base = effectiveBasePeriod(banner, input.playerEffectivePeriod)
    const ticket = input.paymentType === GACHA_PAYMENT_TYPES.TICKET
        ? getGachaTicketCost(input.execType, input.numberOfExec, banner.definition)
        : null
    if (input.paymentType === GACHA_PAYMENT_TYPES.TICKET && ticket === null) {
        throw new GachaRequestError("Gacha ticket is not applicable.")
    }
    let effectivePeriod = base
    if (input.paymentType === GACHA_PAYMENT_TYPES.TICKET
        && input.hasApplicableTicket
        && banner.ticketExpiryTime !== undefined) {
        effectivePeriod = {
            availableFrom: base.availableFrom,
            availableUntil: banner.ticketExpiryTime,
        }
    }
    if (!isGachaPeriodAvailable(effectivePeriod, input.nowMs)) {
        throw new GachaPeriodError("Gacha is outside its available period.")
    }

    let campaign: Readonly<GachaCampaignDefinition> | null = null
    if (input.paymentType === GACHA_PAYMENT_TYPES.CAMPAIGN) {
        const kind = input.execType === GACHA_EXEC_TYPES.CAMPAIGN_MULTI ? 2 : 1
        campaign = resolveGachaCampaign(input.catalog, input.gachaId, input.nowMs, kind)
        if (campaign === null) throw new GachaCampaignPeriodError("No active Gacha campaign.")
    }
    const crazy = input.execType === GACHA_EXEC_TYPES.CRAZY_MULTI_TICKET
    if (crazy && banner.pageKind !== GACHA_PAGE_KINDS.CRAZY_TEN_TIMES_TICKET_ONLY) {
        throw new GachaRequestError("Crazy Gacha page kind is invalid.")
    }
    return {
        kind: crazy ? "crazyCandidate" : "ordinary",
        banner,
        effectivePeriod,
        campaign,
        ticket,
    }
}
