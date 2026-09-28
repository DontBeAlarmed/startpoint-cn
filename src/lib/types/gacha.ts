export enum GachaType {
    CHARACTER,
    WEAPON
}


export enum GachaMovieType {
    NORMAL,
    GUARANTEE
}


export interface GachaPoolItem {
    id: number,
    rank: number,
    odds: number,
    isRateUp: boolean,
    isLimited?: boolean,
    isExchangeable?: boolean,
    trialReadingForced?: boolean,
    rarity: number
}


export interface GachaRankRates {
    normal: number[],
    multiGuarantee: number[]
}

export type GachaRuntimePage =
    | {
        readonly kind: 0
        readonly singleCost: number
        readonly multiCost: number
        readonly dailyPaidCost: number
    }
    | {
        readonly kind: 1
        readonly accountPaidTenCost: number
    }
    | { readonly kind: 2 }
    | { readonly kind: 3 }
    | { readonly kind: 4 }
    | { readonly kind: 5 }
    | {
        readonly kind: 8
        readonly singleCost: number
        readonly multiCost: number
    }

interface GachaRuntimeBannerBase {
    readonly name: string
    readonly page: GachaRuntimePage
    readonly onceTicketItemId?: number
    readonly tenTicketItemId?: number
    readonly crazyTenTicketItemId?: number
    readonly wildcardTicketAvailable: boolean
    readonly rarityOddsId: string
    readonly guaranteeRarity: number
    readonly guaranteeNumber: number
    readonly rankRates: GachaRankRates
    readonly startDate: string
    readonly endDate: string
    readonly ticketExpiryTime?: string
    readonly showPeriod: boolean
    readonly isComeback: boolean
    readonly isStarsGacha: boolean
    readonly freemiumGuaranteeAvailable: boolean
    readonly poolOddsIds: Readonly<Record<string, string>>
}

export interface CharacterGachaRuntimeBanner extends GachaRuntimeBannerBase {
    readonly kind: "character"
    readonly movieName: string
    readonly guaranteeMovieName: string
    readonly toUseOddsUpAsTrialReading: boolean
    readonly canBeStartDashExchange: boolean
}

export interface EquipmentGachaRuntimeBanner extends GachaRuntimeBannerBase {
    readonly kind: "equipment"
    readonly equipmentMovieProbabilityId: string
}

/** Compact authoritative runtime row. Prize lists live only in gacha_pool.json. */
export type GachaRuntimeBanner = CharacterGachaRuntimeBanner | EquipmentGachaRuntimeBanner
export type GachaRuntimeBanners = Readonly<Record<string, GachaRuntimeBanner>>


export interface Gacha {
    name?: string,
    type: GachaType,
    paymentType: number,
    pageKind?: number,
    singleCost: number,
    multiCost: number,
    discountCost: number,
    tenTimesPerAccountCost?: number,
    onceTicketItemId?: number,
    tenTicketItemId?: number,
    crazyTenTicketItemId?: number,
    wildcardTicketAvailable?: boolean,
    rarityOddsId?: string,
    guaranteeRarity?: number,
    guaranteeNumber?: number,
    rankRates?: GachaRankRates,
    equipmentMovieProbabilityId?: string,
    startDate: string,
    endDate: string,
    ticketExpiryTime?: string,
    showPeriod?: boolean,
    isComeback?: boolean,
    isStarsGacha?: boolean,
    freemiumGuaranteeAvailable?: boolean,
    poolOddsIds?: Readonly<Record<string, string>>,
    pool: Readonly<Record<string, readonly GachaPoolItem[]>>
}

export interface GachaCampaignDefinition {
    readonly campaignId: number
    readonly stringId: string
    readonly title: string
    readonly kind: 1 | 2
    readonly availableFrom: string
    readonly availableUntil: string
    readonly gachaIds: readonly number[]
}

export interface StarsGachaCampaignDefinition {
    readonly campaignId: number
    readonly stringId: string
    readonly title: string
    readonly gachaId: number
    readonly availableFrom: string
    readonly availableUntil: string
    readonly oldPlayerDays: number
    readonly newPlayerDays: number
    readonly maximumFreeGachaTimes: number
}

export interface GachaExchangeRates {
    readonly character: Readonly<Record<string, number>>
    readonly equipment: Readonly<Record<string, number>>
}


export interface CharacterGacha extends Gacha {
    movieName: string,
    guaranteeMovieName: string,
    toUseOddsUpAsTrialReading?: boolean,
    canBeStartDashExchange?: boolean
}


export type Gachas = Record<string, Gacha>
export type GachaPools = Readonly<Record<string, readonly GachaPoolItem[]>>


export type GachaDrawResult = number[]


export interface RewardPlayerGachaDrawResult {
    draw: GachaDraws,
    characters: Object[],
    equipment: Object[],
    items: Record<number, number>,
    isErupt?: boolean
    itemOverflowDispositions?: readonly import("../item-overflow").PlannedItemOverflowDisposition[]
    playerAfter?: Readonly<{
        freeMana: number
        freeVmoney: number
        expPool: number
    }>
}


export interface GachaCharacterDraw {
    character_id: number,
    movie_id: string,
    seed: number,
    entry_count: number,
    ex_boost_item?: {
        id: number,
        count: number
    } | []
}


export interface GachaEquipmentDraw {
    equipment_id: number,
    treasure_up_type: number
}


export type GachaDraws = (GachaCharacterDraw | GachaEquipmentDraw)[]



// shops
