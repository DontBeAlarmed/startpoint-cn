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
    getPurchaseCount(playerId: number, shopItemId: number): number
    addPurchaseCount(playerId: number, shopItemId: number, amount: number): number
    recordManaSpent(playerId: number, amount: number): void
    grantRewards(playerId: number, rewards: Reward[]): PlayerRewardResult | null
}

export interface GenericShopPurchaseResult {
    player: GenericShopPlayerState
    rewardResult: PlayerRewardResult
    itemList: Record<string, number>
    purchaseCount: number
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

export function validateShopPurchaseAmount(value: unknown): number {
    if (!Number.isInteger(value) || (value as number) <= 0) {
        throw new InvalidShopPurchaseAmountError()
    }
    return value as number
}

export function parseShopJstTimestamp(value: string): number {
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
    return localDate.getTime() - (9 * 60 * 60 * 1000)
}

export function isShopItemAvailable(shopItem: ShopItem, nowMs: number): boolean {
    const periods = [{
        availableFrom: shopItem.availableFrom,
        availableUntil: shopItem.availableUntil,
    }, ...(shopItem.compatibilityPeriods ?? [])]

    return periods.some(period => {
        const availableFromMs = parseShopJstTimestamp(period.availableFrom)
        const availableUntilMs = period.availableUntil === null
            ? Infinity
            : parseShopJstTimestamp(period.availableUntil)
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

        const purchased = dependencies.getPurchaseCount(input.playerId, input.shopItemId)
        if (input.shopItem.stock > 0 && purchased + purchaseAmount > input.shopItem.stock) {
            throw new ShopStockError()
        }

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

        const purchaseCount = dependencies.addPurchaseCount(
            input.playerId,
            input.shopItemId,
            purchaseAmount,
        )
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
