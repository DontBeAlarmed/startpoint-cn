import { getDb } from "../../data/db"
import {
    getPlayerSpecialExchangeCampaignStatusSync,
    upsertPlayerSpecialExchangeCampaignStatusSync,
} from "../../data/domains/campaign"
import { getPlayerItemSync } from "../../data/domains/item"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import {
    collectRewardGrantItemOverflowDispositions,
    createRewardGrantExecutionPlan,
    snapshotRewardGrantExecutionResultForPlan,
    withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync,
    type RewardGrantExecutionResult,
} from "../reward-grant"
import { createRewardGrantItemOverflowPolicy } from "../reward-grant-item-overflow"
import type { PlannedItemOverflowDisposition } from "../item-overflow"
import {
    withDeferredInventoryBatchContextWithinTransactionSync,
    type InventoryBatchContext,
} from "../inventory"
import { getWildcardTicketPolicySync } from "../config-content"
import { RewardType } from "../types/rewards"
import {
    getSpecialExchangeLineup,
    resolveSpecialExchangeCampaign,
    type SpecialExchangeCampaignDefinition,
} from "./catalog"

/**
 * 带内协议错误码（客户端 RemoteError kind 8 → data_headers.result_code）：
 * - 4715：enter_campaign 活动期外（SpecialExchangeEnterCampaignRealRemote）
 * - 4702：buy_ticket / exchange 活动期外（SpecialExchangeBuyTicketRealRemote）
 */
export const SPECIAL_EXCHANGE_ENTER_PERIOD_ERROR_CODE = 4715
export const SPECIAL_EXCHANGE_PERIOD_ERROR_CODE = 4702

export type SpecialExchangeRejection =
    | {
        readonly ok: false
        readonly kind: "outOfPeriod"
        readonly resultCode: number
    }
    | { readonly ok: false; readonly kind: "insufficientPaidVmoney"; readonly message: string }
    | { readonly ok: false; readonly kind: "badRequest"; readonly message: string }
    | { readonly ok: false; readonly kind: "internal"; readonly message: string }

export interface SpecialExchangeEnterSuccess {
    readonly ok: true
    readonly playerId: number
    readonly campaign: SpecialExchangeCampaignDefinition
    readonly status: number
    /** 礼物型（obtain_source==1）enter 发券时的 item_list 片段；普通进入缺省 */
    readonly items?: Readonly<Record<string, number>>
}

export interface SpecialExchangeBuyTicketSuccess {
    readonly ok: true
    readonly playerId: number
    readonly campaign: SpecialExchangeCampaignDefinition
    readonly status: 2
    readonly paidVmoneyAfter: number
    readonly freeVmoneyAfter: number
    readonly items: Readonly<Record<string, number>>
}

export interface SpecialExchangeTargetSuccess {
    readonly ok: true
    readonly playerId: number
    readonly campaign: SpecialExchangeCampaignDefinition
    readonly status: 3
    readonly characters: readonly Readonly<Record<string, unknown>>[]
    readonly equipment: readonly Readonly<Record<string, unknown>>[]
    readonly items: Readonly<Record<string, number>>
    readonly itemOverflowDispositions: readonly PlannedItemOverflowDisposition[]
    readonly freeManaAfter: number | null
}

export type SpecialExchangeEnterResult =
    | SpecialExchangeEnterSuccess
    | SpecialExchangeRejection

export type SpecialExchangeBuyTicketResult =
    | SpecialExchangeBuyTicketSuccess
    | SpecialExchangeRejection

export type SpecialExchangeTargetResult =
    | SpecialExchangeTargetSuccess
    | SpecialExchangeRejection

function outOfPeriod(resultCode: number): SpecialExchangeRejection {
    return { ok: false, kind: "outOfPeriod", resultCode }
}

function badRequest(message: string): SpecialExchangeRejection {
    return { ok: false, kind: "badRequest", message }
}

function internal(message: string): SpecialExchangeRejection {
    return { ok: false, kind: "internal", message }
}

/** 客户端 SpecialExchangeCampaignLogic 的期间判定：两端闭区间。 */
function isWithinPeriod(startMs: number, endMs: number, nowMs: number): boolean {
    return startMs <= nowMs && nowMs <= endMs
}

function projectGrantedItems(
    results: readonly { itemId: number; afterAmount: number }[],
): Record<string, number> {
    const items: Record<string, number> = {}
    for (const result of results) {
        items[String(result.itemId)] = result.afterAmount
    }
    return items
}

export function enterSpecialExchangeCampaignSync(input: {
    readonly playerId: number
    readonly campaignId: number
    readonly nowMs: number
}): SpecialExchangeEnterResult {
    const campaign = resolveSpecialExchangeCampaign(input.campaignId)
    if (campaign === undefined) {
        return badRequest(`Special exchange campaign ${input.campaignId} does not exist.`)
    }
    if (!isWithinPeriod(campaign.campaignStartTimeMs, campaign.campaignEndTimeMs, input.nowMs)) {
        return outOfPeriod(SPECIAL_EXCHANGE_ENTER_PERIOD_ERROR_CODE)
    }
    // 已进入（1）/已购（2）/已交换（3）不得被重进降级；行缺失（0）落为 1。
    const currentStatus = getPlayerSpecialExchangeCampaignStatusSync(
        input.playerId,
        input.campaignId,
    )
    // 双审 P1（协议保真）：obtain_source==1（礼物型）活动由官方服务器在 enter
    // 时直接发券并推进 status→2（SpecialExchangeEnterCampaignDummyRemote.as:53-97
    // status 0/1 → addItem(ticket,1)+status 2，2/3 不重复发；
    // SpecialExchangeCampaignEnterCampaignLoadingTask.as:74-93 仅 source==1 走
    // enter 且按券差弹 GetItem toast）。
    if (campaign.obtainSource === 1 && currentStatus < 2) {
        return getDb().transaction((): SpecialExchangeEnterResult => {
            upsertPlayerSpecialExchangeCampaignStatusSync(input.playerId, input.campaignId, 2)
            const items = withDeferredInventoryBatchContextWithinTransactionSync({
                playerId: input.playerId,
                preloadItemIds: [campaign.ticketItemId],
                playerExistence: "caller-verified",
            }, (inventory: InventoryBatchContext) => {
                inventory.grant(campaign.ticketItemId, 1)
                return projectGrantedItems(inventory.flush())
            })
            return {
                ok: true,
                playerId: input.playerId,
                campaign,
                status: 2,
                items,
            }
        })()
    }
    if (currentStatus === 0) {
        upsertPlayerSpecialExchangeCampaignStatusSync(input.playerId, input.campaignId, 1)
    }
    return {
        ok: true,
        playerId: input.playerId,
        campaign,
        status: currentStatus === 0 ? 1 : currentStatus,
    }
}

export function buySpecialExchangeTicketSync(input: {
    readonly playerId: number
    readonly campaignId: number
    readonly nowMs: number
}): SpecialExchangeBuyTicketResult {
    const campaign = resolveSpecialExchangeCampaign(input.campaignId)
    if (campaign === undefined) {
        return badRequest(`Special exchange campaign ${input.campaignId} does not exist.`)
    }
    if (campaign.obtainSource !== 0) {
        return badRequest(
            `Special exchange campaign ${input.campaignId} ticket is not purchasable.`,
        )
    }
    if (campaign.price === null) {
        return badRequest(`Special exchange campaign ${input.campaignId} has no price.`)
    }
    const price: number = campaign.price
    if (!isWithinPeriod(campaign.campaignStartTimeMs, campaign.campaignEndTimeMs, input.nowMs)) {
        return outOfPeriod(SPECIAL_EXCHANGE_PERIOD_ERROR_CODE)
    }
    const currentStatus = getPlayerSpecialExchangeCampaignStatusSync(
        input.playerId,
        input.campaignId,
    )
    if (currentStatus >= 2) {
        return badRequest(
            `Special exchange campaign ${input.campaignId} ticket was already purchased.`,
        )
    }

    return getDb().transaction((): SpecialExchangeBuyTicketResult => {
        const player = getPlayerSync(input.playerId)
        if (player === null) return internal("No players bound to account.")
        if (player.vmoney < price) {
            return {
                ok: false,
                kind: "insufficientPaidVmoney",
                message: "Not enough paid vmoney.",
            }
        }
        const paidVmoneyAfter = player.vmoney - price
        updatePlayerSync({ id: input.playerId, vmoney: paidVmoneyAfter })

        const wildcardPolicy = getWildcardTicketPolicySync()
        const wildcardTicketItemId = campaign.type === 0
            ? wildcardPolicy.tenTimesCharacterTicketItemId
            : wildcardPolicy.tenTimesEquipmentTicketItemId
        // 官方购买语义（SpecialExchangeBuyTicketDummyRemote.as:44-54）：自选券
        // 与对应类型的十连券（config wildcard_ten_times_*）一起入包。
        const grantedItemIds = wildcardTicketItemId > 0
            ? [campaign.ticketItemId, wildcardTicketItemId]
            : [campaign.ticketItemId]

        const items = withDeferredInventoryBatchContextWithinTransactionSync({
            playerId: input.playerId,
            preloadItemIds: grantedItemIds,
            playerExistence: "caller-verified",
        }, (inventory: InventoryBatchContext) => {
            for (const itemId of grantedItemIds) {
                inventory.grant(itemId, 1)
            }
            return projectGrantedItems(inventory.flush())
        })

        upsertPlayerSpecialExchangeCampaignStatusSync(input.playerId, input.campaignId, 2)
        console.log(
            `[special_exchange:buy_ticket] player=${input.playerId}`
            + ` campaign=${input.campaignId} price=${price}`
            + ` ticket=${campaign.ticketItemId} paid_after=${paidVmoneyAfter}`,
        )
        return {
            ok: true,
            playerId: input.playerId,
            campaign,
            status: 2,
            paidVmoneyAfter,
            freeVmoneyAfter: player.freeVmoney,
            items,
        }
    })()
}

export function exchangeSpecialExchangeTargetSync(input: {
    readonly playerId: number
    readonly campaignId: number
    readonly targetId: number
    readonly nowMs: number
}): SpecialExchangeTargetResult {
    const campaign = resolveSpecialExchangeCampaign(input.campaignId)
    if (campaign === undefined) {
        return badRequest(`Special exchange campaign ${input.campaignId} does not exist.`)
    }
    const currentStatus = getPlayerSpecialExchangeCampaignStatusSync(
        input.playerId,
        input.campaignId,
    )
    if (currentStatus !== 2) {
        return badRequest(
            `Special exchange campaign ${input.campaignId} ticket has not been purchased.`,
        )
    }
    if (!isWithinPeriod(campaign.exchangeStartTimeMs, campaign.exchangeEndTimeMs, input.nowMs)) {
        return outOfPeriod(SPECIAL_EXCHANGE_PERIOD_ERROR_CODE)
    }
    const lineup = getSpecialExchangeLineup(campaign)
    if (!lineup.includes(input.targetId)) {
        return badRequest(
            `Target ${input.targetId} is not exchangeable in campaign ${input.campaignId}.`,
        )
    }

    return getDb().transaction((): SpecialExchangeTargetResult => {
        const player = getPlayerSync(input.playerId)
        if (player === null) return internal("No players bound to account.")
        const ticketHeld = getPlayerItemSync(input.playerId, campaign.ticketItemId) ?? 0
        if (ticketHeld < 1) {
            return badRequest("Not enough special exchange ticket.")
        }

        const granted = withDeferredInventoryBatchContextWithinTransactionSync({
            playerId: input.playerId,
            preloadItemIds: [campaign.ticketItemId],
            playerExistence: "caller-verified",
        }, (inventory: InventoryBatchContext): Omit<
            SpecialExchangeTargetSuccess,
            "ok" | "playerId" | "campaign" | "status"
        > => {
            inventory.deduct(campaign.ticketItemId, 1)
            // finalize（RewardGrant 内部 flush）会关闭批次上下文，扣券后的余量
            // 必须在 grant 前读取；补偿道具（重复角色的抵偿）从 grant 结果补充。
            const ticketAfter = inventory.read(campaign.ticketItemId).afterAmount
            const plan = createRewardGrantExecutionPlan([{
                type: campaign.type === 0 ? RewardType.CHARACTER : RewardType.EQUIPMENT,
                id: input.targetId,
                count: 1,
            }])
            const grant: RewardGrantExecutionResult = (
                withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync(
                    input.playerId,
                    plan,
                    {
                        playerId: input.playerId,
                        freeMana: player.freeMana,
                        freeVmoney: player.freeVmoney,
                        expPool: player.expPool,
                    },
                    inventory,
                    execution => {
                        const result = snapshotRewardGrantExecutionResultForPlan(
                            input.playerId,
                            plan,
                            execution.result,
                        )
                        execution.finalize()
                        return result
                    },
                    { itemOverflow: createRewardGrantItemOverflowPolicy(input.playerId) },
                )
            )
            const itemOverflowDispositions = collectRewardGrantItemOverflowDispositions(grant)
            const soldMana = itemOverflowDispositions.some(
                disposition => disposition.kind === "sold",
            )
            const freeManaAfter = !soldMana ? null : grant.playerAfter.freeMana
            const items: Record<string, number> = {
                [String(campaign.ticketItemId)]: ticketAfter,
            }
            for (const entry of grant.entries) {
                if (entry.outcome.kind === "character"
                    && entry.outcome.compensationItem !== null) {
                    items[String(entry.outcome.compensationItem.itemId)] =
                        entry.outcome.compensationItem.afterAmount
                }
            }
            return {
                characters: grant.assets.characters.map(character => character.after),
                equipment: grant.assets.equipment.map(equipment => equipment.after),
                items,
                itemOverflowDispositions,
                freeManaAfter,
            }
        })

        upsertPlayerSpecialExchangeCampaignStatusSync(input.playerId, input.campaignId, 3)
        console.log(
            `[special_exchange:exchange] player=${input.playerId} campaign=${input.campaignId}`
            + ` kind=${campaign.type} target=${input.targetId}`,
        )
        return {
            ok: true,
            playerId: input.playerId,
            campaign,
            status: 3,
            ...granted,
        }
    })()
}
