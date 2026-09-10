import { deepFreeze } from "../../content/deep-freeze"
import { planFreeFirstDeduction } from "../economy/free-first-deduction"
import type { Reward, ShopItem } from "../types"
import {
    ShopItemRewardType,
    ShopItemUserCostType,
    ShopType,
} from "../types"
import { resolveEffectiveShopOffer } from "./effective-offer"
import type { EffectiveShopOffer, ShopCatalog } from "./model"
import type { RushFinalOperationOverride } from "./rush-final-operation-override"
import {
    createShopPurchaseCountQuery,
    getShopPurchasePeriodKeys,
    type ShopPurchaseCountQuery,
} from "./purchase-period"
import { appendShopRewardCommands } from "./purchase-rewards"
import {
    checkedAdd,
    checkedMultiply,
    InvalidShopPurchaseCommandError,
    requireNonNegativeSafeInteger,
    requirePositiveSafeInteger,
    ShopPurchaseArithmeticError,
    ShopPurchaseBalancePlanError,
    ShopPurchaseLimitPlanError,
    ShopPurchasePlanError,
} from "./purchase-validation"

export {
    InvalidShopPurchaseCommandError,
    ShopPurchaseArithmeticError,
    ShopPurchaseBalancePlanError,
    ShopPurchaseLimitPlanError,
    ShopPurchasePlanError,
} from "./purchase-validation"

export interface ShopPurchaseCommandEntry {
    readonly shopItemId: number
    readonly purchaseAmount: number
}

export interface PrepareShopPurchaseInput {
    readonly catalog: ShopCatalog
    readonly shopType: ShopType
    readonly entries: readonly ShopPurchaseCommandEntry[]
    readonly virtualNowMs: number
    readonly purchasePeriodNowMs: number
    readonly resetHour?: number
    readonly rushOverride?: RushFinalOperationOverride | null
}

export interface PreparedShopPurchaseEntry extends ShopPurchaseCommandEntry {
    readonly offer: EffectiveShopOffer
    readonly query: ShopPurchaseCountQuery
}

export interface PreparedShopPurchase {
    readonly shopType: ShopType
    readonly entries: readonly PreparedShopPurchaseEntry[]
    readonly purchaseQueries: readonly ShopPurchaseCountQuery[]
    readonly preloadItemIds: readonly number[]
}

export interface ShopPurchaseCountSnapshot {
    readonly daily: number
    readonly monthly: number
    readonly total: number
}

export interface ShopPurchasePlayerState {
    readonly vmoney: number
    readonly freeVmoney: number
    readonly paidMana: number
    readonly freeMana: number
    readonly bondToken: number
    readonly expPool: number
}

export interface CompleteShopPurchaseInput {
    readonly player: ShopPurchasePlayerState
    readonly purchaseCounts: ReadonlyMap<string, ShopPurchaseCountSnapshot>
    readonly itemBalances: Readonly<Record<string | number, number>>
}

export interface ShopItemCostIntent {
    readonly itemId: number
    readonly amount: number
}

export interface ShopPurchaseCountIntent {
    readonly shopType: ShopType
    readonly shopItemId: number
    readonly amount: number
    readonly keys: ShopPurchaseCountQuery["keys"]
    readonly snapshotKey: string
    readonly beforeCounts: ShopPurchaseCountSnapshot
    readonly afterCounts: ShopPurchaseCountSnapshot
}

export type ShopPurchaseEffect =
    | { readonly kind: "standard"; readonly shopItemId: number }
    | { readonly kind: "passCardPoint"; readonly shopItemId: number; readonly points: number }
    | {
        readonly kind: "equipmentEnhancement"
        readonly shopItemId: number
        readonly equipmentId: number
        readonly stage: number
        readonly enhancementMaxLevel: number
        readonly requireAwakeningLevel: number
        readonly purchaseAmount: number
    }

export interface ShopPurchasePlan {
    readonly shopType: ShopType
    readonly entries: readonly PreparedShopPurchaseEntry[]
    readonly playerAfterPayment: ShopPurchasePlayerState
    readonly itemCosts: readonly ShopItemCostIntent[]
    readonly preloadItemIds: readonly number[]
    readonly rewards: readonly Reward[]
    readonly effects: readonly ShopPurchaseEffect[]
    readonly purchaseCountIntents: readonly ShopPurchaseCountIntent[]
    readonly manaSpent: number
}

export function prepareShopPurchase(input: PrepareShopPurchaseInput): PreparedShopPurchase {
    if (!Array.isArray(input.entries) || input.entries.length === 0) {
        throw new InvalidShopPurchaseCommandError("Shop purchase must contain at least one item.")
    }
    if (!Number.isSafeInteger(input.shopType) || input.shopType < 0) {
        throw new InvalidShopPurchaseCommandError("Shop type is invalid.")
    }
    if (!Number.isFinite(input.purchasePeriodNowMs)
        || !Number.isFinite(new Date(input.purchasePeriodNowMs).getTime())
        || (input.resetHour !== undefined && (
            !Number.isSafeInteger(input.resetHour)
            || input.resetHour < 0
            || input.resetHour > 23
        ))) {
        throw new InvalidShopPurchaseCommandError("Shop purchase period time is invalid.")
    }
    if (input.entries.length > 1
        && input.shopType !== ShopType.EVENT_ITEM
        && input.shopType !== ShopType.BOSS_COIN) {
        throw new InvalidShopPurchaseCommandError(
            "Only Event Item and Boss Coin shops support multi-item purchase.",
        )
    }
    const seenIds = new Set<number>()
    const normalized = input.entries.map(command => {
        const shopItemId = requirePositiveSafeInteger(command.shopItemId, "Shop item id")
        const purchaseAmount = requirePositiveSafeInteger(
            command.purchaseAmount,
            "Shop purchase amount",
        )
        if (seenIds.has(shopItemId)) {
            throw new InvalidShopPurchaseCommandError("Shop purchase contains a duplicate item id.")
        }
        seenIds.add(shopItemId)
        return { shopItemId, purchaseAmount }
    }).sort((left, right) => left.shopItemId - right.shopItemId)
    const entries = normalized.map(command => {
        const { shopItemId, purchaseAmount } = command
        const offer = resolveEffectiveShopOffer(
            input.catalog,
            input.shopType,
            shopItemId,
            input.virtualNowMs,
            input.rushOverride ?? null,
        )
        const keys = getShopPurchasePeriodKeys(
            input.purchasePeriodNowMs,
            offer.item.specifiedMonths,
            input.resetHour,
        )
        return {
            shopItemId,
            purchaseAmount,
            offer,
            query: createShopPurchaseCountQuery(input.shopType, shopItemId, keys),
        }
    })
    const preloadIds = new Set<number>()
    for (const entry of entries) {
        for (const cost of entry.offer.item.costs) {
            if (Number.isSafeInteger(cost.id) && cost.id > 0) preloadIds.add(cost.id)
        }
        for (const reward of entry.offer.item.rewards) {
            if (reward.type !== ShopItemRewardType.ITEM) continue
            const rewardId = (reward as { readonly id?: unknown }).id
            if (Number.isSafeInteger(rewardId) && (rewardId as number) > 0) {
                preloadIds.add(rewardId as number)
            }
        }
    }
    return deepFreeze({
        shopType: input.shopType,
        entries,
        purchaseQueries: entries.map(entry => entry.query),
        preloadItemIds: [...preloadIds],
    })
}

function validatedCounts(
    counts: ShopPurchaseCountSnapshot,
    subject: string,
): ShopPurchaseCountSnapshot {
    return {
        daily: requireNonNegativeSafeInteger(counts.daily, `${subject} daily count`),
        monthly: requireNonNegativeSafeInteger(counts.monthly, `${subject} monthly count`),
        total: requireNonNegativeSafeInteger(counts.total, `${subject} total count`),
    }
}

function validateLimit(
    item: Readonly<ShopItem>,
    amount: number,
    counts: ShopPurchaseCountSnapshot,
): void {
    if (!Number.isSafeInteger(item.stock) || item.stock < -1) {
        throw new ShopPurchaseArithmeticError("Shop stock is invalid.")
    }
    if (item.stock >= 0 && amount > item.stock) throw new ShopPurchaseLimitPlanError()
    const limits = [
        ["daily", item.dailyStock, counts.daily],
        ["monthly", item.monthlyStock, counts.monthly],
        ["total", item.maxFrequency, counts.total],
    ] as const
    for (const [subject, limit, current] of limits) {
        if (limit === undefined) continue
        const validLimit = requireNonNegativeSafeInteger(limit, `${subject} stock`)
        if (checkedAdd(current, amount, `${subject} purchase count`) > validLimit) {
            throw new ShopPurchaseLimitPlanError()
        }
    }
    if (item.rewards.some(reward => reward.type === ShopItemRewardType.CHARACTER)
        && item.stock < 0
        && item.dailyStock === undefined
        && item.monthlyStock === undefined
        && item.maxFrequency === undefined) {
        throw new ShopPurchaseArithmeticError(
            "Shop Character rewards require a finite product limit.",
        )
    }
}

function validatedPlayer(player: ShopPurchasePlayerState): ShopPurchasePlayerState {
    return {
        vmoney: requireNonNegativeSafeInteger(player.vmoney, "paid beads"),
        freeVmoney: requireNonNegativeSafeInteger(player.freeVmoney, "free beads"),
        paidMana: requireNonNegativeSafeInteger(player.paidMana, "paid mana"),
        freeMana: requireNonNegativeSafeInteger(player.freeMana, "free mana"),
        bondToken: requireNonNegativeSafeInteger(player.bondToken, "bond token"),
        expPool: requireNonNegativeSafeInteger(player.expPool, "exp pool"),
    }
}

function applyUserCost(
    player: ShopPurchasePlayerState,
    item: Readonly<ShopItem>,
    purchaseAmount: number,
): { player: ShopPurchasePlayerState; manaSpent: number } {
    if (item.userCost === undefined) return { player, manaSpent: 0 }
    const unitCost = requireNonNegativeSafeInteger(item.userCost.amount, "Shop user cost")
    const cost = checkedMultiply(unitCost, purchaseAmount, "Shop user cost")
    const next = { ...player }
    switch (item.userCost.type) {
        case ShopItemUserCostType.MANA: {
            const deduction = planFreeFirstDeduction(next.freeMana, next.paidMana, cost)
            if (deduction === null) throw new ShopPurchaseBalancePlanError("Not enough mana.")
            next.freeMana = deduction.freeBalance
            next.paidMana = deduction.paidBalance
            return { player: next, manaSpent: cost }
        }
        case ShopItemUserCostType.BEADS: {
            const deduction = planFreeFirstDeduction(next.freeVmoney, next.vmoney, cost)
            if (deduction === null) throw new ShopPurchaseBalancePlanError("Not enough beads.")
            next.freeVmoney = deduction.freeBalance
            next.vmoney = deduction.paidBalance
            return { player: next, manaSpent: 0 }
        }
        case ShopItemUserCostType.AMITY_SCROLL:
            if (next.bondToken < cost) {
                throw new ShopPurchaseBalancePlanError("Not enough amity scrolls.")
            }
            next.bondToken -= cost
            return { player: next, manaSpent: 0 }
        case ShopItemUserCostType.PAID_BEADS:
            if (next.vmoney < cost) {
                throw new ShopPurchaseBalancePlanError("Not enough paid beads.")
            }
            next.vmoney -= cost
            return { player: next, manaSpent: 0 }
        default:
            throw new ShopPurchaseArithmeticError("Shop user cost type is invalid.")
    }
}

function planEffect(entry: PreparedShopPurchaseEntry): ShopPurchaseEffect {
    const item = entry.offer.item
    if (entry.offer.shopType === ShopType.TREASURE_EQUIPMENT) {
        return {
            kind: "equipmentEnhancement",
            shopItemId: entry.shopItemId,
            equipmentId: requirePositiveSafeInteger(item.equipmentId, "Equipment id"),
            stage: requireNonNegativeSafeInteger(item.stage, "Equipment enhancement stage"),
            enhancementMaxLevel: requirePositiveSafeInteger(
                item.enhancementMaxLevel,
                "Equipment enhancement max level",
            ),
            requireAwakeningLevel: requireNonNegativeSafeInteger(
                item.requireAwakeningLevel,
                "Equipment required awakening level",
            ),
            purchaseAmount: entry.purchaseAmount,
        }
    }
    if (item.passCardPoints !== undefined) {
        return {
            kind: "passCardPoint",
            shopItemId: entry.shopItemId,
            points: checkedMultiply(
                requirePositiveSafeInteger(item.passCardPoints, "Pass Card points"),
                entry.purchaseAmount,
                "Pass Card points",
            ),
        }
    }
    return { kind: "standard", shopItemId: entry.shopItemId }
}

export function completeShopPurchasePlan(
    prepared: PreparedShopPurchase,
    input: CompleteShopPurchaseInput,
): ShopPurchasePlan {
    const entriesWithCounts = prepared.entries.map(entry => {
        const source = input.purchaseCounts.get(entry.query.key)
        if (source === undefined) {
            throw new ShopPurchasePlanError(
                `Missing purchase count snapshot for shop item ${entry.shopItemId}.`,
            )
        }
        const counts = validatedCounts(source, `Shop item ${entry.shopItemId}`)
        validateLimit(entry.offer.item, entry.purchaseAmount, counts)
        return { entry, counts }
    })

    let nextPlayer = validatedPlayer(input.player)
    let manaSpent = 0
    for (const { entry } of entriesWithCounts) {
        const payment = applyUserCost(nextPlayer, entry.offer.item, entry.purchaseAmount)
        nextPlayer = payment.player
        manaSpent = checkedAdd(manaSpent, payment.manaSpent, "Shop mana spent")
    }

    const itemCostTotals = new Map<number, number>()
    for (const { entry } of entriesWithCounts) {
        for (const cost of entry.offer.item.costs) {
            const itemId = requirePositiveSafeInteger(cost.id, "Shop cost Item id")
            const amount = checkedMultiply(
                requirePositiveSafeInteger(cost.amount, "Shop cost Item amount"),
                entry.purchaseAmount,
                "Shop Item cost",
            )
            itemCostTotals.set(
                itemId,
                checkedAdd(itemCostTotals.get(itemId) ?? 0, amount, "Shop Item cost total"),
            )
        }
    }
    const itemCosts = [...itemCostTotals].map(([itemId, amount]) => ({ itemId, amount }))
    validateShopItemCostBalances({ itemCosts }, input.itemBalances)

    const rewards: Reward[] = []
    const effects: ShopPurchaseEffect[] = []
    const countIntents: ShopPurchaseCountIntent[] = []
    for (const { entry, counts } of entriesWithCounts) {
        appendShopRewardCommands(rewards, entry.offer.item, entry.purchaseAmount)
        effects.push(planEffect(entry))
        const afterCounts = {
            daily: checkedAdd(counts.daily, entry.purchaseAmount, "daily purchase count"),
            monthly: checkedAdd(counts.monthly, entry.purchaseAmount, "monthly purchase count"),
            total: checkedAdd(counts.total, entry.purchaseAmount, "total purchase count"),
        }
        countIntents.push({
            shopType: prepared.shopType,
            shopItemId: entry.shopItemId,
            amount: entry.purchaseAmount,
            keys: entry.query.keys,
            snapshotKey: entry.query.key,
            beforeCounts: counts,
            afterCounts,
        })
    }
    return deepFreeze({
        shopType: prepared.shopType,
        entries: prepared.entries,
        playerAfterPayment: nextPlayer,
        itemCosts,
        preloadItemIds: prepared.preloadItemIds,
        rewards,
        effects,
        purchaseCountIntents: countIntents,
        manaSpent,
    })
}

export function validateShopItemCostBalances(
    plan: Pick<ShopPurchasePlan, "itemCosts">,
    balances: Readonly<Record<string | number, number>>,
): void {
    for (const cost of plan.itemCosts) {
        const balance = requireNonNegativeSafeInteger(
            balances[cost.itemId] ?? 0,
            `Shop cost Item ${cost.itemId} balance`,
        )
        if (balance < cost.amount) {
            throw new ShopPurchaseBalancePlanError(`Not enough of item ${cost.itemId}.`)
        }
    }
}
