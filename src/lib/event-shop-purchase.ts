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

export const ITEM_SHOP_PERIOD_ERROR_CODE = 2053

export interface GenericShopPlayerState {
    id: number
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
    enforcePeriod: boolean
}

export interface GenericShopPurchaseDependencies {
    transaction<T>(operation: () => T): T
    getPlayer(playerId: number): GenericShopPlayerState | null
    updatePlayer(player: GenericShopPlayerState): void
    getItem(playerId: number, itemId: number): number
    setItem(playerId: number, itemId: number, amount: number): void
    getPurchaseCounts(
        playerId: number,
        shopType: number,
        shopItemId: number,
        keys: ShopPurchasePeriodKeys,
    ): ShopPurchaseCounts
    addPurchaseCounts(
        playerId: number,
        shopType: number,
        shopItemId: number,
        amount: number,
        keys: ShopPurchasePeriodKeys,
    ): ShopPurchaseCounts
    recordManaSpent(playerId: number, amount: number): void
    grantRewards(playerId: number, rewards: Reward[]): PlayerRewardResult | null
}

export interface GenericShopPurchaseResult {
    player: GenericShopPlayerState
    rewardResult: PlayerRewardResult
    itemList: Record<string, number>
    purchaseCount: number
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
    enforcePeriod: boolean
}

export interface GenericShopBatchPurchaseResult {
    player: GenericShopPlayerState
    rewardResult: PlayerRewardResult
    itemList: Record<string, number>
    purchaseCounts: Record<string, number>
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

export interface ShopPurchasePeriodKeys {
    readonly daily: string
    readonly monthly: string
}

function pad2(value: number): string {
    return String(value).padStart(2, "0")
}

export function getShopPurchasePeriodKeys(
    nowMs: number,
    specifiedMonths: readonly number[] | undefined,
): ShopPurchasePeriodKeys {
    // CN daily/monthly shop counters reset at 05:00 in UTC+8.
    const shifted = new Date(nowMs + 3 * 60 * 60 * 1000)
    const year = shifted.getUTCFullYear()
    const month = shifted.getUTCMonth() + 1
    const daily = `${year}-${pad2(month)}-${pad2(shifted.getUTCDate())}`
    if (!specifiedMonths || specifiedMonths.length === 0) {
        return { daily, monthly: `${year}-${pad2(month)}` }
    }
    const validMonths = specifiedMonths.filter(value => (
        Number.isSafeInteger(value) && value >= 1 && value <= 12
    ))
    if (validMonths.length !== specifiedMonths.length) {
        throw new ShopPurchaseError("Shop specified months are invalid.")
    }
    const previous = [...validMonths].reverse().find(value => value <= month)
    const periodYear = previous === undefined ? year - 1 : year
    const periodMonth = previous ?? validMonths[validMonths.length - 1]
    return { daily, monthly: `specified:${periodYear}-${pad2(periodMonth)}` }
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
    if (!Number.isInteger(value) || (value as number) <= 0) {
        throw new InvalidShopPurchaseAmountError()
    }
    return value as number
}

export function parseShopCnTimestamp(value: string): number {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
    if (match === null) {
        throw new ShopPurchaseError(`Invalid shop period: ${value}.`)
    }

    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
    const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number)
    const [year, month, day, hour, minute, second] = parts
    const localDate = new Date(0)
    localDate.setUTCFullYear(year, month - 1, day)
    localDate.setUTCHours(hour, minute, second, 0)
    const normalized = [
        localDate.getUTCFullYear(),
        localDate.getUTCMonth() + 1,
        localDate.getUTCDate(),
        localDate.getUTCHours(),
        localDate.getUTCMinutes(),
        localDate.getUTCSeconds(),
    ]
    if (parts.some((part, index) => part !== normalized[index])) {
        throw new ShopPurchaseError(`Invalid shop period: ${value}.`)
    }
    return localDate.getTime() - (8 * 60 * 60 * 1000)
}

export function isShopItemAvailable(shopItem: ShopItem, nowMs: number): boolean {
    const periods = [{
        availableFrom: shopItem.availableFrom,
        availableUntil: shopItem.availableUntil,
    }, ...(shopItem.compatibilityPeriods ?? [])]

    return periods.some(period => {
        const availableFromMs = parseShopCnTimestamp(period.availableFrom)
        const availableUntilMs = period.availableUntil === null
            ? Infinity
            : parseShopCnTimestamp(period.availableUntil)
        return nowMs >= availableFromMs && nowMs <= availableUntilMs
    })
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

        const periodKeys = getShopPurchasePeriodKeys(input.nowMs, input.shopItem.specifiedMonths)
        const counts = dependencies.getPurchaseCounts(
            input.playerId, input.shopType, input.shopItemId, periodKeys,
        )
        validateShopStock(input.shopItem, purchaseAmount, counts)

        const nextPlayer = { ...player }
        const userCost = input.shopItem.userCost
        if (userCost !== undefined) {
            const cost = userCost.amount * purchaseAmount
            switch (userCost.type) {
                case ShopItemUserCostType.MANA:
                    nextPlayer.freeMana -= cost
                    if (nextPlayer.freeMana < 0) throw new ShopBalanceError("Not enough mana.")
                    break
                case ShopItemUserCostType.BEADS:
                    nextPlayer.freeVmoney -= cost
                    if (nextPlayer.freeVmoney < 0) throw new ShopBalanceError("Not enough beads.")
                    break
                case ShopItemUserCostType.AMITY_SCROLL:
                    nextPlayer.bondToken -= cost
                    if (nextPlayer.bondToken < 0) throw new ShopBalanceError("Not enough amity scrolls.")
                    break
            }
        }

        const costTotals = new Map<number, number>()
        for (const cost of input.shopItem.costs) {
            costTotals.set(cost.id, (costTotals.get(cost.id) ?? 0) + cost.amount * purchaseAmount)
        }

        const itemList: Record<string, number> = {}
        for (const [itemId, cost] of costTotals) {
            const nextAmount = dependencies.getItem(input.playerId, itemId) - cost
            if (nextAmount < 0) {
                throw new ShopBalanceError(`Not enough of item ${itemId}.`)
            }
            itemList[String(itemId)] = nextAmount
        }

        dependencies.updatePlayer(nextPlayer)
        for (const [itemId, nextAmount] of Object.entries(itemList)) {
            dependencies.setItem(input.playerId, Number(itemId), nextAmount)
        }

        const rewardResult = dependencies.grantRewards(
            input.playerId,
            buildRewards(input.shopItem, purchaseAmount),
        )
        if (rewardResult === null) throw new ShopPurchaseError("Failed to grant shop rewards.")

        const purchaseCount = dependencies.addPurchaseCounts(
            input.playerId,
            input.shopType,
            input.shopItemId,
            purchaseAmount,
            periodKeys,
        ).total
        if (userCost?.type === ShopItemUserCostType.MANA) {
            dependencies.recordManaSpent(
                input.playerId,
                userCost.amount * purchaseAmount,
            )
        }
        const finalPlayer = dependencies.getPlayer(input.playerId)
        if (finalPlayer === null) throw new ShopPurchaseError("Player disappeared during purchase.")

        return {
            player: finalPlayer,
            rewardResult,
            itemList: {
                ...itemList,
                ...rewardResult.items,
            },
            purchaseCount,
        }
    })
}

export function executeGenericShopBatchPurchaseSync(
    input: GenericShopBatchPurchaseInput,
    dependencies: GenericShopPurchaseDependencies,
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

    return dependencies.transaction(() => {
        const player = dependencies.getPlayer(input.playerId)
        if (player === null) throw new ShopPurchaseError("Player not found.")

        const nextPlayer = { ...player }
        const itemCosts = new Map<number, number>()
        const rewards: Reward[] = []
        let manaSpent = 0

        for (const entry of normalized) {
            const periodKeys = getShopPurchasePeriodKeys(input.nowMs, entry.shopItem.specifiedMonths)
            const counts = dependencies.getPurchaseCounts(
                input.playerId, input.shopType, entry.shopItemId, periodKeys,
            )
            validateShopStock(entry.shopItem, entry.purchaseAmount, counts)

            const userCost = entry.shopItem.userCost
            if (userCost !== undefined) {
                const cost = userCost.amount * entry.purchaseAmount
                switch (userCost.type) {
                    case ShopItemUserCostType.MANA:
                        nextPlayer.freeMana -= cost
                        manaSpent += cost
                        break
                    case ShopItemUserCostType.BEADS:
                        nextPlayer.freeVmoney -= cost
                        break
                    case ShopItemUserCostType.AMITY_SCROLL:
                        nextPlayer.bondToken -= cost
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

        if (nextPlayer.freeMana < 0) throw new ShopBalanceError("Not enough mana.")
        if (nextPlayer.freeVmoney < 0) throw new ShopBalanceError("Not enough beads.")
        if (nextPlayer.bondToken < 0) throw new ShopBalanceError("Not enough amity scrolls.")

        const itemList: Record<string, number> = {}
        for (const [itemId, cost] of itemCosts) {
            const nextAmount = dependencies.getItem(input.playerId, itemId) - cost
            if (nextAmount < 0) throw new ShopBalanceError(`Not enough of item ${itemId}.`)
            itemList[String(itemId)] = nextAmount
        }

        dependencies.updatePlayer(nextPlayer)
        for (const [itemId, nextAmount] of Object.entries(itemList)) {
            dependencies.setItem(input.playerId, Number(itemId), nextAmount)
        }

        const rewardResult = dependencies.grantRewards(input.playerId, rewards)
        if (rewardResult === null) throw new ShopPurchaseError("Failed to grant shop rewards.")

        const purchaseCounts: Record<string, number> = {}
        for (const entry of normalized) {
            const periodKeys = getShopPurchasePeriodKeys(input.nowMs, entry.shopItem.specifiedMonths)
            purchaseCounts[String(entry.shopItemId)] = dependencies.addPurchaseCounts(
                input.playerId,
                input.shopType,
                entry.shopItemId,
                entry.purchaseAmount,
                periodKeys,
            ).total
        }
        if (manaSpent > 0) dependencies.recordManaSpent(input.playerId, manaSpent)

        const finalPlayer = dependencies.getPlayer(input.playerId)
        if (finalPlayer === null) throw new ShopPurchaseError("Player disappeared during purchase.")
        return {
            player: finalPlayer,
            rewardResult,
            itemList: { ...itemList, ...rewardResult.items },
            purchaseCounts,
        }
    })
}
