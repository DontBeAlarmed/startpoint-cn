import { getDb } from "../data/db"
import {
    confirmPlayerNormalLoginBonusShownSync,
    getPlayerNormalLoginBonusProgressSync,
    upsertPlayerNormalLoginBonusProgressSync,
    type PlayerNormalLoginBonusProgress,
} from "../data/domains/login-bonus"
import {
    selectActiveNormalLoginBonusGroup,
    type LoginBonusEntry,
    type LoginBonusReward,
    type NormalLoginBonusCatalog,
} from "../content/converters/login-bonus"
import { getDayBucket } from "./time-utils"
import {
    createRewardGrantPlan,
    executeRewardGrantPlanWithinTransactionSync,
    type RewardGrantResult,
} from "./reward-grant"
import { RewardType } from "./types/rewards"

export { getPlayerNormalLoginBonusProgressSync }

export interface NormalLoginBonusStatus {
    readonly groupId: string
    readonly index: number
    readonly receivedAt: number
}

interface NormalLoginBonusSource {
    readonly groupId: string
    readonly index: number
    readonly slot: number
}

export type NormalLoginBonusSettlement = Readonly<
    | { status: "none" }
    | { status: "pending"; bonus: NormalLoginBonusStatus }
    | {
        status: "granted"
        bonus: NormalLoginBonusStatus
        grant: RewardGrantResult<NormalLoginBonusSource>
    }
>

export interface SettleNormalLoginBonusInput {
    readonly playerId: number
    readonly virtualNowMs: number
    readonly dailyResetHour: number
    readonly catalog: NormalLoginBonusCatalog
}

function toBusinessDay(virtualNowMs: number, dailyResetHour: number): string {
    const bucket = getDayBucket(new Date(virtualNowMs), dailyResetHour)
    return [
        String(bucket.y).padStart(4, "0"),
        String(bucket.m + 1).padStart(2, "0"),
        String(bucket.d).padStart(2, "0"),
    ].join("-")
}

function toStatus(progress: PlayerNormalLoginBonusProgress): NormalLoginBonusStatus {
    return {
        groupId: progress.groupId,
        index: progress.lastGrantedIndex,
        receivedAt: progress.receivedAt,
    }
}

function toRewardGrantReward(reward: LoginBonusReward) {
    switch (reward.kind) {
        case 0:
            return { type: RewardType.BEADS as const, count: reward.count }
        case 1:
            return { type: RewardType.ITEM as const, id: reward.id as number, count: reward.count }
        case 2:
            return { type: RewardType.CHARACTER as const, id: reward.id as number }
        case 3:
            return { type: RewardType.MANA as const, count: reward.count }
        case 4:
            return { type: RewardType.EXP as const, count: reward.count }
    }
}

function createLoginBonusRewardPlan(groupId: string, entry: LoginBonusEntry) {
    return createRewardGrantPlan(entry.rewards.map((reward, slot) => ({
        source: { groupId, index: entry.index, slot: slot + 1 },
        reward: toRewardGrantReward(reward),
    })))
}

function nextEntryIndex(
    progress: PlayerNormalLoginBonusProgress | null,
    groupId: string,
    entries: readonly LoginBonusEntry[],
): number {
    if (progress === null || progress.groupId !== groupId) return 1
    return entries.some(entry => entry.index === progress.lastGrantedIndex + 1)
        ? progress.lastGrantedIndex + 1
        : 1
}

export function settleNormalLoginBonusSync(
    input: SettleNormalLoginBonusInput,
): NormalLoginBonusSettlement {
    if (!Number.isSafeInteger(input.playerId) || input.playerId <= 0) {
        throw new TypeError("playerId must be a positive safe integer")
    }
    if (!Number.isFinite(input.virtualNowMs)) throw new TypeError("virtualNowMs must be finite")
    if (!Number.isSafeInteger(input.dailyResetHour)
        || input.dailyResetHour < 0
        || input.dailyResetHour > 23) {
        throw new TypeError("dailyResetHour must be an integer from 0 to 23")
    }

    return getDb().transaction(() => {
        const progress = getPlayerNormalLoginBonusProgressSync(input.playerId)
        if (progress !== null && progress.shownAt === null) {
            return { status: "pending", bonus: toStatus(progress) } as const
        }

        const businessDay = toBusinessDay(input.virtualNowMs, input.dailyResetHour)
        if (progress !== null && businessDay <= progress.lastGrantedBusinessDay) {
            return { status: "none" } as const
        }
        const active = selectActiveNormalLoginBonusGroup(input.catalog, input.virtualNowMs)
        if (active === null) return { status: "none" } as const

        const index = nextEntryIndex(progress, active.groupId, active.group.entries)
        const entry = active.group.entries.find(candidate => candidate.index === index)
        if (entry === undefined) throw new Error(`login bonus entry is missing: ${active.groupId}[${index}]`)

        const receivedAt = Math.floor(input.virtualNowMs / 1000)
        const grant = executeRewardGrantPlanWithinTransactionSync(
            input.playerId,
            createLoginBonusRewardPlan(active.groupId, entry),
        )
        const nextProgress: PlayerNormalLoginBonusProgress = {
            groupId: active.groupId,
            lastGrantedIndex: index,
            lastGrantedBusinessDay: businessDay,
            receivedAt,
            shownAt: null,
        }
        upsertPlayerNormalLoginBonusProgressSync(input.playerId, nextProgress)
        return { status: "granted", bonus: toStatus(nextProgress), grant } as const
    })()
}

export function confirmNormalLoginBonusShownSync(
    playerId: number,
    virtualNowMs: number,
): boolean {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
        throw new TypeError("playerId must be a positive safe integer")
    }
    if (!Number.isFinite(virtualNowMs)) throw new TypeError("virtualNowMs must be finite")
    return confirmPlayerNormalLoginBonusShownSync(playerId, Math.floor(virtualNowMs / 1000))
}
