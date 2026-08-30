export type GiftProtocolType = 1 | 4 | 5 | 6 | 8 | 9
export type GiftStatus = "stopped" | "active"

export interface GiftReward {
    readonly position: number
    readonly type: GiftProtocolType
    readonly typeId: number | null
    readonly number: number
}

export interface GiftDraft {
    readonly code: string
    readonly note: string | null
    readonly rewards: readonly GiftReward[]
}

export interface GiftDefinition {
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

export interface GiftDefinitionPage {
    readonly rows: readonly GiftDefinition[]
    readonly totalCount: number
    readonly page: number
    readonly pageSize: number
}

export type GiftReceiveResult =
    | { readonly resultCode: 1; readonly rewards: readonly GiftReward[] }
    | { readonly resultCode: 6101 | 6103 | 6104; readonly rewards: readonly [] }
