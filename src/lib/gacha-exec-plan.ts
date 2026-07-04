import { Gacha, GachaType } from "./types";
import { getGachaTicketCost } from "./gacha-ticket";
import { GACHA_EXEC_TYPES, GACHA_PAGE_KINDS, GACHA_PAYMENT_TYPES, isGachaExecAllowed } from "./gacha-rules";

export interface GachaExecPlayerFunds {
    freeVmoney: number
    paidVmoney: number
}

export interface GachaExecPlayerGachaData {
    isAccountFirst: boolean
    isDailyFirst: boolean
    gachaExchangePoint?: number
}

export interface GachaExecCampaignState {
    campaignId: number
    count: number
    insert: boolean
}

export interface GachaExecTicketPlan {
    itemId: number
    beforeCount: number
    afterCount: number
    useTicketCount: number
}

export interface GachaExecCampaignPlan {
    campaignId: number
    count: number
    insert: boolean
}

export interface GachaExecPlan {
    pullCount: number
    freeVmoney: number
    paidVmoney: number
    ticket: GachaExecTicketPlan | null
    campaign: GachaExecCampaignPlan | null
}

export type GachaExecPlanResult =
    | { ok: true, plan: GachaExecPlan }
    | { ok: false, status: 400, message: string }

export interface BuildGachaExecPlanInput {
    gacha: Gacha
    paymentType: number
    execType: number
    numberOfExec: number
    playerFunds: GachaExecPlayerFunds
    playerGachaData: GachaExecPlayerGachaData
    getTicketCount?: (itemId: number) => number | null
    getCampaignState?: () => GachaExecCampaignState | null
}

function ok(plan: GachaExecPlan): GachaExecPlanResult {
    return { ok: true, plan }
}

function badRequest(message: string): GachaExecPlanResult {
    return { ok: false, status: 400, message }
}

function basePlan(playerFunds: GachaExecPlayerFunds): GachaExecPlan {
    return {
        pullCount: 0,
        freeVmoney: playerFunds.freeVmoney,
        paidVmoney: playerFunds.paidVmoney,
        ticket: null,
        campaign: null,
    }
}

function ensureNonNegativeFunds(plan: GachaExecPlan): GachaExecPlanResult {
    if (plan.freeVmoney < 0 || plan.paidVmoney < 0) {
        return badRequest("Not enough beads.")
    }
    return ok(plan)
}

export function buildGachaExecPlan(input: BuildGachaExecPlanInput): GachaExecPlanResult {
    const { gacha, paymentType, execType, numberOfExec, playerFunds, playerGachaData } = input

    if (!isGachaExecAllowed(gacha, paymentType, execType)) {
        return badRequest("Gacha execution type is not allowed for this gacha.")
    }

    if (gacha.pageKind === GACHA_PAGE_KINDS.TEN_TIMES_PER_ACCOUNT && !playerGachaData.isAccountFirst) {
        return badRequest("Already did account-limited summon.")
    }

    const plan = basePlan(playerFunds)

    switch (paymentType) {
        case GACHA_PAYMENT_TYPES.FREE_VMONEY: {
            const isMulti = execType === GACHA_EXEC_TYPES.VMONEY_MULTI
            const cost = (gacha.pageKind === GACHA_PAGE_KINDS.TEN_TIMES_PER_ACCOUNT && isMulti)
                ? (gacha.tenTimesPerAccountCost ?? gacha.multiCost)
                : (isMulti ? gacha.multiCost : gacha.singleCost)
            const overflow = cost > plan.freeVmoney ? cost - plan.freeVmoney : 0
            plan.freeVmoney = overflow > 0 ? 0 : plan.freeVmoney - cost
            plan.paidVmoney = overflow > 0 ? plan.paidVmoney - overflow : plan.paidVmoney
            plan.pullCount = isMulti ? 10 : 1
            break
        }
        case GACHA_PAYMENT_TYPES.VMONEY: {
            if (!playerGachaData.isDailyFirst) {
                return badRequest("Already did daily paid summon.")
            }

            plan.paidVmoney -= gacha.type === GachaType.CHARACTER ? 50 : 25
            plan.pullCount = 1
            break
        }
        case GACHA_PAYMENT_TYPES.TICKET: {
            const ticketCost = getGachaTicketCost(execType, numberOfExec, gacha)
            if (ticketCost === null) {
                return badRequest("Invalid payment type.")
            }

            const beforeCount = input.getTicketCount?.(ticketCost.itemId) ?? -1
            const afterCount = beforeCount - ticketCost.useTicketCount
            if (afterCount < 0) {
                return badRequest("Not enough tickets.")
            }

            plan.pullCount = ticketCost.pullCount
            plan.ticket = {
                itemId: ticketCost.itemId,
                beforeCount,
                afterCount,
                useTicketCount: ticketCost.useTicketCount,
            }
            break
        }
        case GACHA_PAYMENT_TYPES.CAMPAIGN: {
            const campaignState = input.getCampaignState?.() ?? null
            if (campaignState === null) {
                return badRequest("No gacha campaign assigned to gacha.")
            }
            if (campaignState.count <= 0) {
                return badRequest("Already redeemed campaign for this period.")
            }

            plan.pullCount = execType === GACHA_EXEC_TYPES.CAMPAIGN_MULTI ? 10 : 1
            plan.campaign = {
                campaignId: campaignState.campaignId,
                count: 0,
                insert: campaignState.insert,
            }
            break
        }
        default:
            return badRequest("Invalid payment type.")
    }

    if (plan.pullCount === 0) {
        return badRequest("Invalid payment type.")
    }

    return ensureNonNegativeFunds(plan)
}
