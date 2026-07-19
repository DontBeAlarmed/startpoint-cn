import { ShopItemReward } from "./rewards"

export enum ShopItemUserCostType {
    BEADS,
    MANA,
    AMITY_SCROLL,
}


export enum ShopType {
    U0,
    U1,
    TREASURE,
    SPECIAL_PACK,
    EVENT_ITEM,
    U5,
    U6,
    BOSS_COIN,
    GENERAL,
    STAR_GRAIN,
    TREASURE_EQUIPMENT = 10  // CN: 追忆装备强化 / 特殊装备强化
}


export interface ShopItemCost {
    id: number,
    amount: number
}


export interface ShopItemUserCost {
    type: ShopItemUserCostType
    amount: number
}

export interface ShopItemAvailabilityPeriod {
    availableFrom: string
    availableUntil: string | null
}

export interface ShopItem {
    costs: ShopItemCost[] | never[],
    rewards: ShopItemReward[] | never[],
    availableFrom: string,
    availableUntil: string | null,
    stock: number
    userCost?: ShopItemUserCost
    shopCategoryId?: number
    groupId?: number
    stage?: number
    equipmentId?: number
    enhancementMaxLevel?: number
    requireAwakeningLevel?: number
    maxFrequency?: number
    dailyStock?: number
    monthlyStock?: number
    compatibilityPeriods?: ShopItemAvailabilityPeriod[]
}


export interface EventItemShopIdMapItem {
    eventType: number
    eventId: number
}


export type ShopItems = Record<string, ShopItem>

export type BossCoinShopItems = Record<string, ShopItems>

export type EventShopItems = Record<string, BossCoinShopItems>

// rush event
