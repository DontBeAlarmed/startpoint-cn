import { getPlayerShopCampaignLineupsSync } from "../../data/domains/shop-campaign-lineup"
import {
    addPlayerShopPurchaseCountsByTypeFromSnapshotSync,
    getPlayerShopPurchaseCountsByTypeBulkSync,
} from "../../data/domains/shopPurchase"
import { incrementActiveMissionUsedManaCountSync } from "../../data/domains/active_mission_counters"
import { publishActiveMissionOwnerStateWithinTransaction } from "../mission/active-publication-owner"
import { getPlayerSync } from "../../data/domains/player"
import { getDb } from "../../data/db"
import { deepFreeze } from "../../content/deep-freeze"
import { withDeferredInventoryBatchContextWithinTransactionSync } from "../inventory"
import { settleMissionOperationFactsSync } from "../mission/operation-fact-settlement"
import { grantShopRewardsTypedInTransactionOwnerWithInventorySync } from "../shop-reward-grant"
import { ShopType } from "../types/shop"
import {
    applyPreparedEquipmentEnhancementWithinTransactionSync,
    prepareEquipmentEnhancementWithinTransactionSync,
    type PreparedEquipmentEnhancement,
} from "./equipment-enhancement-adapter"
import { getShopCatalog } from "./catalog"
import type { ShopCatalog } from "./model"
import type { RushFinalOperationOverride } from "../rush-final-operation-override"
import {
    applyPreparedShopPassCardEffectWithinTransactionSync,
    prepareShopPassCardEffect,
    type AppliedShopPassCardEffect,
    type PreparedShopPassCardEffect,
} from "./pass-card-adapter"
import { persistShopPaymentWithinTransactionSync } from "./payment-adapter"
import {
    completeShopPurchasePlan,
    prepareShopPurchase,
    type ShopPurchaseCommandEntry,
} from "./purchase-plan"
import { ShopPurchasePlanError } from "./purchase-validation"
import type { ShopPurchaseOwnerResult } from "./result"

export interface ExecuteShopPurchaseInput {
    readonly playerId: number
    readonly shopType: ShopType
    readonly entries: readonly ShopPurchaseCommandEntry[]
    readonly virtualNowMs: number
    readonly purchasePeriodNowMs: number
    readonly resetHour?: number
    readonly catalog?: ShopCatalog
    readonly rushOverride?: RushFinalOperationOverride | null
}

function authorizeCampaignLineups(
    playerId: number,
    prepared: ReturnType<typeof prepareShopPurchase>,
): void {
    const restricted = prepared.entries.filter(entry => (
        (entry.offer.scope.kind === "event" || entry.offer.scope.kind === "bossCoin")
        && entry.offer.scope.lineupId !== undefined
    ))
    if (restricted.length === 0) return
    const selections = getPlayerShopCampaignLineupsSync(playerId)
    for (const entry of restricted) {
        const scope = entry.offer.scope
        if ((scope.kind !== "event" && scope.kind !== "bossCoin")
            || scope.campaignId === undefined
            || scope.lineupId === undefined
            || selections[`${entry.offer.shopType}:${scope.campaignId}`] !== scope.lineupId) {
            throw new ShopPurchasePlanError("Shop campaign lineup is not selected.")
        }
    }
}

function sameCounts(
    actual: { daily: number; monthly: number; total: number },
    expected: { daily: number; monthly: number; total: number },
): boolean {
    return actual.daily === expected.daily
        && actual.monthly === expected.monthly
        && actual.total === expected.total
}

export function executeShopPurchaseSync(
    input: ExecuteShopPurchaseInput,
): ShopPurchaseOwnerResult {
    const catalog = input.catalog ?? getShopCatalog()
    const prepared = prepareShopPurchase({
        catalog,
        shopType: input.shopType,
        entries: input.entries,
        virtualNowMs: input.virtualNowMs,
        purchasePeriodNowMs: input.purchasePeriodNowMs,
        resetHour: input.resetHour,
        rushOverride: input.rushOverride ?? null,
    })
    const virtualNow = new Date(input.virtualNowMs)

    return getDb().transaction(() => {
        const player = getPlayerSync(input.playerId)
        if (player === null) throw new ShopPurchasePlanError("Player not found.")
        const originalSnapshots = getPlayerShopPurchaseCountsByTypeBulkSync(
            input.playerId,
            prepared.purchaseQueries,
        )
        authorizeCampaignLineups(input.playerId, prepared)

        return withDeferredInventoryBatchContextWithinTransactionSync({
            playerId: input.playerId,
            preloadItemIds: prepared.preloadItemIds,
            playerExistence: "caller-verified",
        }, inventory => {
            const itemBalances = Object.fromEntries(
                inventory.readMany(prepared.preloadItemIds).map(item => [
                    item.itemId,
                    item.afterAmount,
                ]),
            )
            const plan = completeShopPurchasePlan(prepared, {
                player,
                purchaseCounts: originalSnapshots,
                itemBalances,
            })

            const equipmentPrepared: PreparedEquipmentEnhancement[] = []
            const passPrepared: PreparedShopPassCardEffect[] = []
            for (const effect of plan.effects) {
                if (effect.kind === "equipmentEnhancement") {
                    const entry = prepared.entries.find(candidate => (
                        candidate.shopItemId === effect.shopItemId
                    ))
                    if (entry === undefined) throw new ShopPurchasePlanError("Shop effect entry is missing.")
                    equipmentPrepared.push(prepareEquipmentEnhancementWithinTransactionSync(
                        input.playerId,
                        entry,
                        effect,
                        catalog,
                    ))
                } else if (effect.kind === "passCardPoint") {
                    passPrepared.push(prepareShopPassCardEffect(effect, virtualNow))
                }
            }

            const paymentAfter = persistShopPaymentWithinTransactionSync(
                player,
                plan.playerAfterPayment,
            )
            const itemList: Record<string, number> = {}
            for (const cost of plan.itemCosts) {
                itemList[String(cost.itemId)] = inventory.deduct(
                    cost.itemId,
                    cost.amount,
                ).afterAmount
            }
            const reward = grantShopRewardsTypedInTransactionOwnerWithInventorySync(
                input.playerId,
                plan.rewards,
                paymentAfter,
                inventory,
                { virtualNow, knownPaidMana: paymentAfter.paidMana },
            )
            for (const item of reward.execution.assets.items) {
                itemList[String(item.itemId)] = item.afterAmount
            }

            for (const effect of equipmentPrepared) {
                applyPreparedEquipmentEnhancementWithinTransactionSync(input.playerId, effect)
            }
            const passEffects: AppliedShopPassCardEffect[] = passPrepared.map(effect => (
                applyPreparedShopPassCardEffectWithinTransactionSync(input.playerId, effect)
            ))

            const purchaseCounts = plan.purchaseCountIntents.map(intent => {
                const original = originalSnapshots.get(intent.snapshotKey)
                if (original === undefined) {
                    throw new ShopPurchasePlanError("Original purchase count snapshot is missing.")
                }
                const after = addPlayerShopPurchaseCountsByTypeFromSnapshotSync(
                    input.playerId,
                    intent.shopType,
                    intent.shopItemId,
                    intent.amount,
                    intent.keys,
                    original,
                )
                if (!sameCounts(after, intent.afterCounts)) {
                    throw new ShopPurchasePlanError("Purchase count writer result diverged from plan.")
                }
                return { shopItemId: intent.shopItemId, ...after }
            })

            let missionSettlement = null
            if (plan.manaSpent > 0) {
                incrementActiveMissionUsedManaCountSync(input.playerId, plan.manaSpent)
                if (input.shopType === ShopType.TREASURE) {
                    missionSettlement = settleMissionOperationFactsSync(
                        input.playerId,
                        "treasure_mana",
                        plan.manaSpent,
                        virtualNow,
                    )
                    if (missionSettlement !== null) {
                        Object.assign(itemList, missionSettlement.itemList)
                    }
                }
            }
            const missionUser = missionSettlement?.userInfo
            const activeMission = publishActiveMissionOwnerStateWithinTransaction({
                playerId: input.playerId,
                now: virtualNow,
                source: "shop/purchase",
            })
            return deepFreeze({
                playerId: input.playerId,
                shopType: input.shopType,
                playerAfter: {
                    ...plan.playerAfterPayment,
                    freeMana: reward.execution.playerAfter.freeMana,
                    freeVmoney: reward.execution.playerAfter.freeVmoney,
                    expPool: reward.execution.playerAfter.expPool,
                    ...(missionUser?.free_mana === undefined
                        ? {}
                        : { freeMana: missionUser.free_mana }),
                    ...(missionUser?.free_vmoney === undefined
                        ? {}
                        : { freeVmoney: missionUser.free_vmoney }),
                    ...(missionUser?.exp_pool === undefined
                        ? {}
                        : { expPool: missionUser.exp_pool }),
                },
                itemAfter: Object.entries(itemList).map(([itemId, afterAmount]) => ({
                    itemId: Number(itemId),
                    afterAmount,
                })),
                characters: reward.execution.assets.characters,
                equipmentRewards: reward.execution.assets.equipment,
                joinedCharacterIds: reward.execution.assets.characters
                    .filter(character => character.joined)
                    .map(character => character.characterId),
                itemOverflowDispositions: reward.itemOverflowDispositions,
                equipmentEnhancements: equipmentPrepared,
                passCardEffects: passEffects,
                purchaseCounts,
                rewardInvalidatedFactKeys: reward.invalidatedFactKeys,
                missionSettlement,
                activeMissionList: activeMission.activeMissionList,
            })
        })
    })()
}
