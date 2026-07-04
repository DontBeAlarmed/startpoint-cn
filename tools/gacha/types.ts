// ── Types ─────────────────────────────────────────────────────
export interface PoolItem {
    id: number;
    rank: number;
    odds: number;
    isRateUp: boolean;
    isLimited?: boolean;
    isExchangeable?: boolean;
    trialReadingForced?: boolean;
    rarity: number;
}

export interface GachaBanner {
    type: number;
    paymentType: number;
    pageKind?: number;
    singleCost: number;
    multiCost: number;
    discountCost: number;
    tenTimesPerAccountCost?: number;
    onceTicketItemId?: number;
    tenTicketItemId?: number;
    wildcardTicketAvailable?: boolean;
    rarityOddsId?: string;
    guaranteeRarity?: number;
    rankRates?: {
        normal: number[];
        multiGuarantee: number[];
    };
    movieName?: string;
    guaranteeMovieName?: string;
    toUseOddsUpAsTrialReading?: boolean;
    canBeStartDashExchange?: boolean;
    equipmentMovieProbabilityId?: string;
    startDate: string;
    endDate: string;
    name: string;
    pool: Record<string, PoolItem[]>;
}

export interface CharacterTableEntry {
    name: string;
    code_number: string | number;
    code_name: string;
    rarity: number;
    source: string;
    available_from?: string;
}

export interface EquipmentTableEntry {
    name: string;
    rarity: number;
    element: string;
    source: string;
}
