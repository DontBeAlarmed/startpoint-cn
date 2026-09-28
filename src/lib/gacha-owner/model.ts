import type {
    GachaCharacterDraw,
    GachaEquipmentDraw,
} from "../types"
import type { PlannedItemOverflowDisposition } from "../item-overflow"
import type {
    GachaCharacterSampledLogSnapshot,
    GachaSeedMarkSnapshot,
} from "../gacha-reward-grant"

export interface GachaExecCommand {
    readonly playerId: number
    readonly gachaId: number
    readonly paymentType: number
    readonly execType: number
    readonly numberOfExec: number
    readonly nowMs: number
}

export type GachaPostCommitEffect =
    | ({ readonly kind: "seedMark" } & GachaSeedMarkSnapshot)
    | ({ readonly kind: "sampledLog" } & GachaCharacterSampledLogSnapshot)
    | {
        readonly kind: "characterGrowthPublication"
        readonly playerId: number
        readonly characterIds: readonly number[]
        readonly characters: readonly Readonly<Record<string, unknown>>[]
        readonly source: "gacha/exec" | "gacha/exchange_character" | "gacha/crazy_select"
    }

export interface GachaCampaignAfter {
    readonly gachaId: number
    readonly campaignId: number
    readonly count: number
}

export interface GachaStarsCampaignAfter {
    readonly campaignId: number
    readonly freeOneTimes: number
    readonly freeTenTimes: number
}

interface GachaExecSuccessBase {
    readonly ok: true
    readonly playerId: number
    readonly gachaId: number
    readonly freeVmoney: number
    readonly paidVmoney: number
    readonly exchangePoint: number
    readonly isDailyFirst: boolean
    readonly isAccountFirst: boolean
    readonly mailArrived: boolean
    readonly ticketItemBalances: Readonly<Record<number, number>>
    readonly campaignList: readonly GachaCampaignAfter[]
    readonly starsCampaignList: readonly GachaStarsCampaignAfter[]
    readonly rewardItems: Readonly<Record<number, number>>
    readonly playerAfter?: Readonly<{
        readonly freeMana: number
        readonly freeVmoney: number
        readonly expPool: number
    }>
    readonly itemOverflowDispositions: readonly PlannedItemOverflowDisposition[]
    readonly postCommitEffects: readonly GachaPostCommitEffect[]
    readonly activeMissionList: readonly unknown[]
}

export interface CharacterGachaExecSuccess extends GachaExecSuccessBase {
    readonly kind: "character"
    readonly draw: readonly GachaCharacterDraw[]
    readonly characters: readonly Readonly<Record<string, unknown>>[]
}

export interface EquipmentGachaExecSuccess extends GachaExecSuccessBase {
    readonly kind: "equipment"
    readonly draw: readonly GachaEquipmentDraw[]
    readonly equipment: readonly Readonly<Record<string, unknown>>[]
    readonly isErupt: boolean
}

export type GachaExecSuccess = CharacterGachaExecSuccess | EquipmentGachaExecSuccess

export interface GachaExecRejected {
    readonly ok: false
    readonly kind: "badRequest"
    readonly message: string
}

export interface GachaExecProtocolRejected {
    readonly ok: false
    readonly kind: "protocolResultCode"
    readonly resultCode: 1351 | 1361
    readonly message: string
}

export type GachaExecResult = GachaExecSuccess | GachaExecRejected | GachaExecProtocolRejected

interface GachaExchangeSuccessBase {
    readonly ok: true
    readonly playerId: number
    readonly gachaId: number
    readonly targetId: number
    readonly exchangePoint: number
    readonly isDailyFirst: boolean
    readonly isAccountFirst: boolean
    readonly mailArrived: boolean
    readonly rewardItems: Readonly<Record<number, number>>
    readonly playerAfter?: Readonly<{
        readonly freeMana: number
        readonly freeVmoney: number
        readonly expPool: number
    }>
    readonly itemOverflowDispositions: readonly PlannedItemOverflowDisposition[]
    readonly postCommitEffects: readonly GachaPostCommitEffect[]
}

export interface CharacterGachaExchangeSuccess extends GachaExchangeSuccessBase {
    readonly kind: "character"
    readonly characters: readonly Readonly<Record<string, unknown>>[]
}

export interface EquipmentGachaExchangeSuccess extends GachaExchangeSuccessBase {
    readonly kind: "equipment"
    readonly equipment: readonly Readonly<Record<string, unknown>>[]
}

export type GachaExchangeSuccess = CharacterGachaExchangeSuccess | EquipmentGachaExchangeSuccess
export type GachaExchangeResult = GachaExchangeSuccess | GachaExecRejected | GachaExecProtocolRejected

export interface GachaPostCommitResult {
    readonly characterList: readonly Record<string, unknown>[]
}

export interface CrazyGachaCandidateSuccess {
    readonly ok: true
    readonly kind: "crazyCandidate"
    readonly playerId: number
    readonly gachaId: number
    readonly draw: readonly GachaCharacterDraw[]
    readonly crazyDrawCount: number
    readonly exchangePoint: number
    readonly isDailyFirst: boolean
    readonly isAccountFirst: boolean
    readonly ticketItemBalances: Readonly<Record<number, number>>
    readonly slots: Readonly<Record<number, readonly number[]>>
    readonly postCommitEffects: readonly GachaPostCommitEffect[]
}

export interface CrazyGachaSaveSuccess {
    readonly ok: true
    readonly kind: "crazySave"
    readonly gachaId: number
    readonly slots: Readonly<Record<number, readonly number[]>>
}

export interface CrazyGachaSelectSuccess {
    readonly ok: true
    readonly kind: "crazySelect"
    readonly playerId: number
    readonly gachaId: number
    readonly characters: readonly Readonly<Record<string, unknown>>[]
    readonly rewardItems: Readonly<Record<number, number>>
    readonly playerAfter?: Readonly<{
        readonly freeMana: number
        readonly freeVmoney: number
        readonly expPool: number
    }>
    readonly itemOverflowDispositions: readonly PlannedItemOverflowDisposition[]
    readonly mailArrived: boolean
    readonly postCommitEffects: readonly GachaPostCommitEffect[]
}

export type CrazyGachaCandidateResult = CrazyGachaCandidateSuccess
    | GachaExecRejected | GachaExecProtocolRejected
export type CrazyGachaSaveResult = CrazyGachaSaveSuccess
    | GachaExecRejected | GachaExecProtocolRejected
export type CrazyGachaSelectResult = CrazyGachaSelectSuccess
    | GachaExecRejected | GachaExecProtocolRejected
