import type { PlayerEquipment } from "../../data/types"
import type { FactKey } from "../mission/facts/fact-key"
import type { MissionSettlementResult } from "../mission/settlement"
import type {
    PlannedItemOverflowDisposition,
} from "../item-overflow"
import type {
    RewardGrantFinalCharacter,
    RewardGrantFinalEquipment,
} from "../reward-grant"
import type { ShopType } from "../types/shop"
import type { ShopPurchasePlayerState } from "./purchase-plan"
import type { AppliedShopPassCardEffect } from "./pass-card-adapter"
import type { PreparedEquipmentEnhancement } from "./equipment-enhancement-adapter"

export interface ShopPurchaseCountAfter {
    readonly shopItemId: number
    readonly daily: number
    readonly monthly: number
    readonly total: number
}

export interface ShopItemAbsoluteState {
    readonly itemId: number
    readonly afterAmount: number
}

export interface ShopPurchaseOwnerResult {
    readonly playerId: number
    readonly shopType: ShopType
    readonly playerAfter: ShopPurchasePlayerState
    readonly itemAfter: readonly ShopItemAbsoluteState[]
    readonly characters: readonly RewardGrantFinalCharacter[]
    readonly equipmentRewards: readonly RewardGrantFinalEquipment[]
    readonly joinedCharacterIds: readonly number[]
    readonly itemOverflowDispositions: readonly PlannedItemOverflowDisposition[]
    readonly equipmentEnhancements: readonly PreparedEquipmentEnhancement[]
    readonly passCardEffects: readonly AppliedShopPassCardEffect[]
    readonly purchaseCounts: readonly ShopPurchaseCountAfter[]
    readonly rewardInvalidatedFactKeys: readonly FactKey[]
    readonly activeMissionList: readonly unknown[]
    readonly missionSettlement: MissionSettlementResult | null
}

export type ShopEquipmentAbsoluteState = Readonly<PlayerEquipment>
