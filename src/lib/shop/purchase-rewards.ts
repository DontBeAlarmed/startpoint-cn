import type {
    CharacterReward,
    CharacterShopItemReward,
    CurrencyReward,
    CurrencyShopItemReward,
    EquipmentItemReward,
    EquipmentItemShopItemReward,
    Reward,
    ShopItem,
} from "../types"
import { RewardType, ShopItemRewardType } from "../types"
import {
    checkedMultiply,
    requirePositiveSafeInteger,
    ShopPurchaseArithmeticError,
} from "./purchase-validation"

export function appendShopRewardCommands(
    output: Reward[],
    item: Readonly<ShopItem>,
    purchaseAmount: number,
): void {
    for (const reward of item.rewards) {
        switch (reward.type) {
            case ShopItemRewardType.ITEM: {
                const value = reward as EquipmentItemShopItemReward
                output.push({
                    type: RewardType.ITEM,
                    id: requirePositiveSafeInteger(value.id, "Shop Item reward id"),
                    count: checkedMultiply(
                        requirePositiveSafeInteger(value.count, "Shop Item reward count"),
                        purchaseAmount,
                        "Shop Item reward",
                    ),
                } as EquipmentItemReward)
                break
            }
            case ShopItemRewardType.EXP:
            case ShopItemRewardType.MANA: {
                const value = reward as CurrencyShopItemReward
                output.push({
                    type: reward.type === ShopItemRewardType.EXP
                        ? RewardType.EXP
                        : RewardType.MANA,
                    count: checkedMultiply(
                        requirePositiveSafeInteger(value.count, "Shop currency reward count"),
                        purchaseAmount,
                        "Shop currency reward",
                    ),
                } as CurrencyReward)
                break
            }
            case ShopItemRewardType.CHARACTER: {
                const value = reward as CharacterShopItemReward
                const characterId = requirePositiveSafeInteger(
                    value.id,
                    "Shop Character reward id",
                )
                for (let index = 0; index < purchaseAmount; index++) {
                    output.push({ type: RewardType.CHARACTER, id: characterId } as CharacterReward)
                }
                break
            }
            case ShopItemRewardType.EQUIPMENT: {
                const value = reward as EquipmentItemShopItemReward
                output.push({
                    type: RewardType.EQUIPMENT,
                    id: requirePositiveSafeInteger(value.id, "Shop Equipment reward id"),
                    count: checkedMultiply(
                        requirePositiveSafeInteger(value.count, "Shop Equipment reward count"),
                        purchaseAmount,
                        "Shop Equipment reward",
                    ),
                } as EquipmentItemReward)
                break
            }
            default:
                throw new ShopPurchaseArithmeticError("Shop reward type is invalid.")
        }
    }
}
