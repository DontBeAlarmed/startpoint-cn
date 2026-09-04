import type {
    GachaCampaignDefinition,
    GachaExchangeRates,
    GachaPoolItem,
    CharacterGachaRuntimeBanner,
    EquipmentGachaRuntimeBanner,
    StarsGachaCampaignDefinition,
} from "../types/gacha"

export interface GachaPeriod {
    readonly availableFrom: string
    readonly availableUntil: string
}

export interface GachaWeightedPool {
    readonly oddsId: string
    readonly items: readonly Readonly<GachaPoolItem>[]
    readonly cumulativeWeights: readonly number[]
    readonly totalWeight: number
}

interface GachaBannerBase {
    readonly gachaId: number
    readonly pageKind: number
    readonly basePeriod: GachaPeriod
    readonly ticketExpiryTime?: string
    readonly poolsByRank: Readonly<Record<string, GachaWeightedPool>>
}

export interface CharacterGachaBanner extends GachaBannerBase {
    readonly kind: "character"
    readonly definition: Readonly<CharacterGachaRuntimeBanner>
}

export interface EquipmentGachaBanner extends GachaBannerBase {
    readonly kind: "equipment"
    readonly definition: Readonly<EquipmentGachaRuntimeBanner>
}

export type GachaBanner = CharacterGachaBanner | EquipmentGachaBanner

export interface GachaCatalog {
    readonly banners: Readonly<Record<string, GachaBanner>>
    readonly pools: Readonly<Record<string, GachaWeightedPool>>
    readonly campaigns: Readonly<Record<string, Readonly<GachaCampaignDefinition>>>
    readonly campaignIdsByGachaId: Readonly<Record<string, readonly number[]>>
    readonly starsCampaigns: Readonly<Record<string, Readonly<StarsGachaCampaignDefinition>>>
    readonly exchangeRates: Readonly<GachaExchangeRates>
    readonly exchangeableByGachaAndItem: Readonly<Record<string, Readonly<GachaPoolItem>>>
}
