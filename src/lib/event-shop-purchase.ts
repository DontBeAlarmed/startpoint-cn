import {
    CharacterReward,
    CharacterShopItemReward,
    CurrencyReward,
    CurrencyShopItemReward,
    EquipmentItemReward,
    EquipmentItemShopItemReward,
    PlayerRewardResult,
    Reward,
    RewardType,
    ShopItem,
    ShopItemRewardType,
    ShopItemUserCostType,
} from "./types"
import {
    getShopPurchaseQueryKey,
} from "../data/domains/shopPurchase"
import type {
    ShopPurchaseCountSnapshot,
    ShopPurchaseQuery,
} from "../data/domains/shopPurchase"
import { planFreeFirstDeduction } from "./economy/free-first-deduction"
import type { InventoryBatchContext } from "./inventory"
import type { FactKey } from "./mission/facts/fact-key"
import {
    isShopItemAvailable,
    parseShopCnTimestamp,
} from "./shop/period"
import {
    getShopPurchasePeriodKeys,
    type ShopPurchasePeriodKeys,
} from "./shop/purchase-period"

export { isShopItemAvailable, parseShopCnTimestamp } from "./shop/period"
export { getShopPurchasePeriodKeys } from "./shop/purchase-period"
export type { ShopPurchasePeriodKeys } from "./shop/purchase-period"

export const ITEM_SHOP_PERIOD_ERROR_CODE = 2053

export interface GenericShopPlayerState {
    id: number
    vmoney: number
    paidMana: number
    freeMana: number
    freeVmoney: number
    bondToken: number
    expPool: number
}

export interface GenericShopPurchaseInput {
    playerId: number
    shopType: number
    shopItemId: number
    purchaseAmount: number
    shopItem: ShopItem
    nowMs: number
    periodNowMs?: number
    resetHour?: number
    enforcePeriod: boolean
}

export interface GenericShopPurchaseDependencies {
    transaction<T>(operation: () => T): T
    getPlayer(playerId: number): GenericShopPlayerState | null
    updatePlayer(player: GenericShopPlayerState): void
    withInventory<T>(
        playerId: number,
        preloadItemIds: readonly number[],
        operation: (inventory: InventoryBatchContext) => T,
    ): T
    getPurchaseCounts(
        playerId: number,
        shopType: number,
        shopItemId: number,
        keys: ShopPurchasePeriodKeys,
    ): ShopPurchaseCountSnapshot
    addPurchaseCounts(
        playerId: number,
        shopType: number,
        shopItemId: number,
        amount: number,
        keys: ShopPurchasePeriodKeys,
        currentCounts: ShopPurchaseCountSnapshot,
    ): ShopPurchaseCounts
    recordManaSpent(playerId: number, amount: number): void
    grantRewards(
        playerId: number,
        rewards: Reward[],
        knownPlayerBefore: GenericShopPlayerState,
        inventory: InventoryBatchContext,
    ): GenericShopRewardGrantResult
    grantPassCardPoints?(playerId: number, amount: number): void
}

export interface GenericShopBatchPurchaseDependencies
    extends Omit<
        GenericShopPurchaseDependencies,
        "getPurchaseCounts" | "addPurchaseCounts"
    > {
    getPurchaseCountsBulk(
        playerId: number,
        queries: readonly ShopPurchaseQuery[],
    ): ReadonlyMap<string, ShopPurchaseCountSnapshot>
    addPurchaseCountsFromSnapshot(
        playerId: number,
        shopType: number,
        shopItemId: number,
        amount: number,
        keys: ShopPurchasePeriodKeys,
        currentCounts: ShopPurchaseCountSnapshot,
    ): ShopPurchaseCounts
}

export interface GenericShopRewardGrantResult {
    rewardResult: PlayerRewardResult
    playerAfter: Pick<GenericShopPlayerState, "freeMana" | "freeVmoney" | "expPool">
    rewardInvalidatedFactKeys: readonly FactKey[]
}

export interface GenericShopPurchaseResult {
    player: GenericShopPlayerState
    rewardResult: PlayerRewardResult
    itemList: Record<string, number>
    purchaseCount: number
    rewardInvalidatedFactKeys: readonly FactKey[]
}

export interface GenericShopBatchPurchaseEntry {
    shopItemId: number
    purchaseAmount: number
    shopItem: ShopItem
}

export interface GenericShopBatchPurchaseInput {
    playerId: number
    shopType: number
    purchases: readonly GenericShopBatchPurchaseEntry[]
    nowMs: number
    periodNowMs?: number
    resetHour?: number
    enforcePeriod: boolean
}

export interface GenericShopBatchPurchaseResult {
    player: GenericShopPlayerState
    rewardResult: PlayerRewardResult
    itemList: Record<string, number>
    purchaseCounts: Record<string, number>
    rewardInvalidatedFactKeys: readonly FactKey[]
}

export class ShopPurchaseError extends Error {}

export class InvalidShopPurchaseAmountError extends ShopPurchaseError {
    constructor() {
        super("Shop purchase amount must be a positive integer.")
        this.name = "InvalidShopPurchaseAmountError"
    }
}

export class ShopPeriodError extends ShopPurchaseError {
    readonly resultCode = ITEM_SHOP_PERIOD_ERROR_CODE

    constructor() {
        super("Shop item is outside its available period.")
        this.name = "ShopPeriodError"
    }
}

export class ShopStockError extends ShopPurchaseError {
    constructor() {
        super("Shop item purchase limit reached.")
        this.name = "ShopStockError"
    }
}

export class ShopBalanceError extends ShopPurchaseError {
    constructor(message: string) {
        super(message)
        this.name = "ShopBalanceError"
    }
}

export interface ShopPurchaseCounts {
    readonly daily: number
    readonly monthly: number
    readonly total: number
}

export interface EquipmentEnhancementPurchaseCountInput {
    readonly playerId: number
    readonly shopType: number
    readonly shopItemId: number
    readonly purchaseAmount: number
    readonly nowMs: number
    readonly resetHour?: number
    readonly specifiedMonths: readonly number[] | undefined
}

export interface EquipmentEnhancementPurchaseCountDependencies {
    getShopPurchasePeriodKeys(
        nowMs: number,
        specifiedMonths: readonly number[] | undefined,
        resetHour?: number,
    ): ShopPurchasePeriodKeys
    addPurchaseCounts(
        playerId: number,
        shopType: number,
        shopItemId: number,
        amount: number,
        keys: ShopPurchasePeriodKeys,
    ): ShopPurchaseCounts
}

export function recordEquipmentEnhancementPurchaseSync(
    input: EquipmentEnhancementPurchaseCountInput,
    dependencies: EquipmentEnhancementPurchaseCountDependencies,
): ShopPurchaseCounts {
    const periodKeys = dependencies.getShopPurchasePeriodKeys(
        input.nowMs,
        input.specifiedMonths,
        input.resetHour,
    )
    return dependencies.addPurchaseCounts(
        input.playerId,
        input.shopType,
        input.shopItemId,
        input.purchaseAmount,
        periodKeys,
    )
}

export function validateShopStock(
    shopItem: ShopItem,
    purchaseAmount: number,
    counts: ShopPurchaseCounts,
): void {
    if (shopItem.stock >= 0 && purchaseAmount > shopItem.stock) throw new ShopStockError()
    if (shopItem.dailyStock !== undefined
        && counts.daily + purchaseAmount > shopItem.dailyStock) throw new ShopStockError()
    if (shopItem.monthlyStock !== undefined
        && counts.monthly + purchaseAmount > shopItem.monthlyStock) throw new ShopStockError()
    if (shopItem.maxFrequency !== undefined
        && counts.total + purchaseAmount > shopItem.maxFrequency) throw new ShopStockError()
}

export function calculateShopStockQuantity(
    shopItem: ShopItem,
    counts: ShopPurchaseCounts,
): number {
    const remaining: number[] = []
    if (shopItem.dailyStock !== undefined) remaining.push(shopItem.dailyStock - counts.daily)
    if (shopItem.monthlyStock !== undefined) remaining.push(shopItem.monthlyStock - counts.monthly)
    if (shopItem.maxFrequency !== undefined) remaining.push(shopItem.maxFrequency - counts.total)
    return remaining.length === 0 ? -1 : Math.max(0, Math.min(...remaining))
}

export function validateShopPurchaseAmount(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new InvalidShopPurchaseAmountError()
    }
    return value as number
}

function buildRewards(shopItem: ShopItem, purchaseAmount: number): Reward[] {
    const rewards: Reward[] = []
    for (const reward of shopItem.rewards) {
        switch (reward.type) {
            case ShopItemRewardType.ITEM: {
                const itemReward = reward as EquipmentItemShopItemReward
                rewards.push({
                    type: RewardType.ITEM,
                    id: itemReward.id,
                    count: itemReward.count * purchaseAmount,
                } as EquipmentItemReward)
                break
            }
            case ShopItemRewardType.EXP: {
                const currencyReward = reward as CurrencyShopItemReward
                rewards.push({
                    type: RewardType.EXP,
                    count: currencyReward.count * purchaseAmount,
                } as CurrencyReward)
                break
            }
            case ShopItemRewardType.MANA: {
                const currencyReward = reward as CurrencyShopItemReward
                rewards.push({
                    type: RewardType.MANA,
                    count: currencyReward.count * purchaseAmount,
                } as CurrencyReward)
                break
            }
            case ShopItemRewardType.CHARACTER: {
                const characterReward = reward as CharacterShopItemReward
                for (let i = 0; i < purchaseAmount; i++) {
                    rewards.push({
                        type: RewardType.CHARACTER,
                        id: characterReward.id,
                    } as CharacterReward)
                }
                break
            }
            case ShopItemRewardType.EQUIPMENT: {
                const equipmentReward = reward as EquipmentItemShopItemReward
                rewards.push({
                    type: RewardType.EQUIPMENT,
                    id: equipmentReward.id,
                    count: equipmentReward.count * purchaseAmount,
                } as EquipmentItemReward)
                break
            }
        }
    }
    return rewards
}

function directItemRewardIds(rewards: readonly Reward[]): number[] {
    return [...new Set(rewards.flatMap(reward => {
        switch (reward.type) {
            case RewardType.ITEM:
            case RewardType.ELEMENT:
            case RewardType.AETHER:
                return [reward.id!]
            default:
                return []
        }
    }))]
}

export function executeGenericShopPurchaseSync(
    input: GenericShopPurchaseInput,
    dependencies: GenericShopPurchaseDependencies,
): GenericShopPurchaseResult {
    const purchaseAmount = validateShopPurchaseAmount(input.purchaseAmount)
    if (input.enforcePeriod && !isShopItemAvailable(input.shopItem, input.nowMs)) {
        throw new ShopPeriodError()
    }

    return dependencies.transaction(() => {
        const player = dependencies.getPlayer(input.playerId)
        if (player === null) throw new ShopPurchaseError("Player not found.")

        const periodKeys = getShopPurchasePeriodKeys(
            input.periodNowMs ?? input.nowMs,
            input.shopItem.specifiedMonths,
            input.resetHour,
        )
        const counts = dependencies.getPurchaseCounts(
            input.playerId, input.shopType, input.shopItemId, periodKeys,
        )
        validateShopStock(input.shopItem, purchaseAmount, counts)

        const nextPlayer = { ...player }
        const userCost = input.shopItem.userCost
        if (userCost !== undefined) {
            const cost = userCost.amount * purchaseAmount
            switch (userCost.type) {
                case ShopItemUserCostType.MANA: {
                    const deduction = planFreeFirstDeduction(
                        nextPlayer.freeMana,
                        nextPlayer.paidMana,
                        cost,
                    )
                    if (deduction === null) throw new ShopBalanceError("Not enough mana.")
                    nextPlayer.freeMana = deduction.freeBalance
                    nextPlayer.paidMana = deduction.paidBalance
                    break
                }
                case ShopItemUserCostType.BEADS: {
                    const deduction = planFreeFirstDeduction(
                        nextPlayer.freeVmoney,
                        nextPlayer.vmoney,
                        cost,
                    )
                    if (deduction === null) throw new ShopBalanceError("Not enough beads.")
                    nextPlayer.freeVmoney = deduction.freeBalance
                    nextPlayer.vmoney = deduction.paidBalance
                    break
                }
                case ShopItemUserCostType.AMITY_SCROLL:
                    nextPlayer.bondToken -= cost
                    if (nextPlayer.bondToken < 0) throw new ShopBalanceError("Not enough amity scrolls.")
                    break
                case ShopItemUserCostType.PAID_BEADS:
                    nextPlayer.vmoney -= cost
                    if (nextPlayer.vmoney < 0) throw new ShopBalanceError("Not enough paid beads.")
                    break
            }
        }

        const costTotals = new Map<number, number>()
        for (const cost of input.shopItem.costs) {
            costTotals.set(cost.id, (costTotals.get(cost.id) ?? 0) + cost.amount * purchaseAmount)
        }
        const rewards = buildRewards(input.shopItem, purchaseAmount)

        return dependencies.withInventory(
            input.playerId,
            [...costTotals.keys(), ...directItemRewardIds(rewards)],
            inventory => {
                for (const [itemId, cost] of costTotals) {
                    if (inventory.read(itemId).afterAmount < cost) {
                        throw new ShopBalanceError(`Not enough of item ${itemId}.`)
                    }
                }

                dependencies.updatePlayer(nextPlayer)
                const itemList: Record<string, number> = {}
                for (const [itemId, cost] of costTotals) {
                    itemList[String(itemId)] = inventory.deduct(itemId, cost).afterAmount
                }

                const rewardGrant = dependencies.grantRewards(
                    input.playerId,
                    rewards,
                    nextPlayer,
                    inventory,
                )
                const rewardResult = rewardGrant.rewardResult
                if (input.shopItem.passCardPoints !== undefined) {
                    if (!dependencies.grantPassCardPoints) {
                        throw new ShopPurchaseError("Pass card point rewards are unavailable.")
                    }
                    dependencies.grantPassCardPoints(
                        input.playerId,
                        input.shopItem.passCardPoints * purchaseAmount,
                    )
                }

                const purchaseCount = dependencies.addPurchaseCounts(
                    input.playerId,
                    input.shopType,
                    input.shopItemId,
                    purchaseAmount,
                    periodKeys,
                    counts,
                ).total
                if (userCost?.type === ShopItemUserCostType.MANA) {
                    dependencies.recordManaSpent(
                        input.playerId,
                        userCost.amount * purchaseAmount,
                    )
                }
                const finalPlayer = {
                    ...nextPlayer,
                    ...rewardGrant.playerAfter,
                }

                return {
                    player: finalPlayer,
                    rewardResult,
                    itemList: {
                        ...itemList,
                        ...rewardResult.items,
                    },
                    purchaseCount,
                    rewardInvalidatedFactKeys: rewardGrant.rewardInvalidatedFactKeys,
                }
            }
        )
    })
}

export function executeGenericShopBatchPurchaseSync(
    input: GenericShopBatchPurchaseInput,
    dependencies: GenericShopBatchPurchaseDependencies,
): GenericShopBatchPurchaseResult {
    if (!Array.isArray(input.purchases) || input.purchases.length === 0) {
        throw new ShopPurchaseError("Shop batch must contain at least one item.")
    }

    const normalized = input.purchases.map(entry => ({
        ...entry,
        purchaseAmount: validateShopPurchaseAmount(entry.purchaseAmount),
    }))
    const itemIds = new Set<number>()
    for (const entry of normalized) {
        if (!Number.isSafeInteger(entry.shopItemId) || entry.shopItemId <= 0
            || itemIds.has(entry.shopItemId)) {
            throw new ShopPurchaseError("Shop batch contains an invalid or duplicate item id.")
        }
        itemIds.add(entry.shopItemId)
        if (input.enforcePeriod && !isShopItemAvailable(entry.shopItem, input.nowMs)) {
            throw new ShopPeriodError()
        }
    }
    const purchasesWithQueries = normalized.map(entry => {
        const periodKeys = getShopPurchasePeriodKeys(
            input.periodNowMs ?? input.nowMs,
            entry.shopItem.specifiedMonths,
            input.resetHour,
        )
        const query: ShopPurchaseQuery = {
            shopType: input.shopType,
            shopItemId: entry.shopItemId,
            keys: periodKeys,
        }
        return { ...entry, periodKeys, query }
    })

    return dependencies.transaction(() => {
        const player = dependencies.getPlayer(input.playerId)
        if (player === null) throw new ShopPurchaseError("Player not found.")

        const purchaseCountsByKey = dependencies.getPurchaseCountsBulk(
            input.playerId,
            purchasesWithQueries.map(entry => entry.query),
        )

        const nextPlayer = { ...player }
        const itemCosts = new Map<number, number>()
        const rewards: Reward[] = []
        const currentCountsByItem = new Map<number, ShopPurchaseCountSnapshot>()
        let manaSpent = 0

        for (const entry of purchasesWithQueries) {
            const counts = purchaseCountsByKey.get(getShopPurchaseQueryKey(entry.query))
            if (counts === undefined) {
                throw new ShopPurchaseError(
                    `Missing bulk purchase counts for shop item ${entry.shopItemId}.`,
                )
            }
            validateShopStock(entry.shopItem, entry.purchaseAmount, counts)
            currentCountsByItem.set(entry.shopItemId, counts)

            const userCost = entry.shopItem.userCost
            if (userCost !== undefined) {
                const cost = userCost.amount * entry.purchaseAmount
                switch (userCost.type) {
                    case ShopItemUserCostType.MANA: {
                        const deduction = planFreeFirstDeduction(
                            nextPlayer.freeMana,
                            nextPlayer.paidMana,
                            cost,
                        )
                        if (deduction === null) throw new ShopBalanceError("Not enough mana.")
                        nextPlayer.freeMana = deduction.freeBalance
                        nextPlayer.paidMana = deduction.paidBalance
                        manaSpent += cost
                        break
                    }
                    case ShopItemUserCostType.BEADS: {
                        const deduction = planFreeFirstDeduction(
                            nextPlayer.freeVmoney,
                            nextPlayer.vmoney,
                            cost,
                        )
                        if (deduction === null) throw new ShopBalanceError("Not enough beads.")
                        nextPlayer.freeVmoney = deduction.freeBalance
                        nextPlayer.vmoney = deduction.paidBalance
                        break
                    }
                    case ShopItemUserCostType.AMITY_SCROLL:
                        nextPlayer.bondToken -= cost
                        break
                    case ShopItemUserCostType.PAID_BEADS:
                        nextPlayer.vmoney -= cost
                        break
                }
            }
            for (const cost of entry.shopItem.costs) {
                itemCosts.set(
                    cost.id,
                    (itemCosts.get(cost.id) ?? 0) + cost.amount * entry.purchaseAmount,
                )
            }
            rewards.push(...buildRewards(entry.shopItem, entry.purchaseAmount))
        }

        if (nextPlayer.vmoney < 0) throw new ShopBalanceError("Not enough paid beads.")
        if (nextPlayer.bondToken < 0) throw new ShopBalanceError("Not enough amity scrolls.")

        return dependencies.withInventory(
            input.playerId,
            [...itemCosts.keys(), ...directItemRewardIds(rewards)],
            inventory => {
                for (const [itemId, cost] of itemCosts) {
                    if (inventory.read(itemId).afterAmount < cost) {
                        throw new ShopBalanceError(`Not enough of item ${itemId}.`)
                    }
                }

                dependencies.updatePlayer(nextPlayer)
                const itemList: Record<string, number> = {}
                for (const [itemId, cost] of itemCosts) {
                    itemList[String(itemId)] = inventory.deduct(itemId, cost).afterAmount
                }

                const rewardGrant = dependencies.grantRewards(
                    input.playerId,
                    rewards,
                    nextPlayer,
                    inventory,
                )
                const rewardResult = rewardGrant.rewardResult

                const purchaseCounts: Record<string, number> = {}
                for (const entry of purchasesWithQueries) {
                    purchaseCounts[String(entry.shopItemId)] = dependencies.addPurchaseCountsFromSnapshot(
                        input.playerId,
                        input.shopType,
                        entry.shopItemId,
                        entry.purchaseAmount,
                        entry.periodKeys,
                        currentCountsByItem.get(entry.shopItemId)!,
                    ).total
                }
                if (manaSpent > 0) dependencies.recordManaSpent(input.playerId, manaSpent)

                const finalPlayer = {
                    ...nextPlayer,
                    ...rewardGrant.playerAfter,
                }
                return {
                    player: finalPlayer,
                    rewardResult,
                    itemList: { ...itemList, ...rewardResult.items },
                    purchaseCounts,
                    rewardInvalidatedFactKeys: rewardGrant.rewardInvalidatedFactKeys,
                }
            },
        )
    })
}
