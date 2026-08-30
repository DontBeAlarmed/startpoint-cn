export type GiftProtocolType = 1 | 4 | 5 | 6 | 8 | 9
export type GiftStatus = "stopped" | "active"

export interface GiftReward {
    readonly position: number
    readonly type: GiftProtocolType
    readonly typeId: number | null
    readonly number: number
}

export interface AdminGiftRow {
    readonly id: number
    readonly code: string
    readonly status: GiftStatus
    readonly note: string | null
    readonly rewardRevision: number
    readonly revision: number
    readonly rewards: readonly GiftReward[]
    readonly redemptionCount: number
    readonly createdAt: string
    readonly updatedAt: string
}

export interface GiftPage {
    readonly rows: readonly AdminGiftRow[]
    readonly totalCount: number
    readonly page: number
    readonly pageSize: number
}

export interface GiftRedemptionRow {
    readonly playerId: number
    readonly accountId: number
    readonly playerName: string
    readonly redeemedAt: string
    readonly rewardRevision: number
    readonly rewardSnapshot: readonly GiftReward[]
    readonly inherited: boolean
    readonly sourcePlayerId: number | null
}

export interface GiftRedemptionPage {
    readonly rows: readonly GiftRedemptionRow[]
    readonly totalCount: number
    readonly page: number
    readonly pageSize: number
}

export interface GiftDraftRequest {
    readonly code: string
    readonly note: string | null
    readonly rewards: readonly GiftReward[]
    readonly revision?: number
}

export const GIFT_REWARD_TYPES = [
    { value: 1, label: "道具" },
    { value: 4, label: "免费星导石" },
    { value: 5, label: "角色" },
    { value: 6, label: "装备" },
    { value: 8, label: "免费玛纳" },
    { value: 9, label: "经验值" },
] as const satisfies ReadonlyArray<{ value: GiftProtocolType; label: string }>
