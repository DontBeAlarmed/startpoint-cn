import { getDb } from "../data/db"
import {
    confirmPlayerLoginBonusShownSync,
    listPlayerLoginBonusProgressSync,
    upsertPlayerLoginBonusProgressSync,
    type PlayerLoginBonusProgress,
    type PlayerNormalLoginBonusProgress,
} from "../data/domains/login-bonus"
import {
    selectActiveLoginBonusGroups,
    selectActiveNormalLoginBonusGroup,
    type LoginBonusCatalog,
    type LoginBonusEntry,
    type LoginBonusGroup,
    type LoginBonusGroupType,
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

export { getPlayerNormalLoginBonusProgressSync } from "../data/domains/login-bonus"

export interface LoginBonusStatus {
    readonly groupId: string
    readonly groupType: LoginBonusGroupType
    readonly index: number
    readonly receivedAt: number
}

interface LoginBonusSource {
    readonly groupId: string
    readonly groupType: LoginBonusGroupType
    readonly index: number
    readonly slot: number
}

export type LoginBonusSettlement = Readonly<
    | { status: "none" }
    | {
        status: "pending"
        bonuses: readonly LoginBonusStatus[]
        bonus: LoginBonusStatus
    }
    | {
        status: "granted"
        bonuses: readonly LoginBonusStatus[]
        bonus: LoginBonusStatus
        grant: RewardGrantResult<LoginBonusSource>
    }
>

export interface SettleLoginBonusInput {
    readonly playerId: number
    readonly virtualNowMs: number
    readonly dailyResetHour: number
    readonly catalog: LoginBonusCatalog
    readonly previousLastLoginMs?: number
    readonly isBeginner?: boolean
}

export type NormalLoginBonusSettlement = LoginBonusSettlement

export interface SettleNormalLoginBonusInput {
    readonly playerId: number
    readonly virtualNowMs: number
    readonly dailyResetHour: number
    readonly catalog: NormalLoginBonusCatalog
}

const DAY_MS = 24 * 60 * 60 * 1000

function toBusinessDay(virtualNowMs: number, dailyResetHour: number): string {
    const bucket = getDayBucket(new Date(virtualNowMs), dailyResetHour)
    return [
        String(bucket.y).padStart(4, "0"),
        String(bucket.m + 1).padStart(2, "0"),
        String(bucket.d).padStart(2, "0"),
    ].join("-")
}

function toStatus(
    progress: PlayerLoginBonusProgress,
    groupType: LoginBonusGroupType,
): LoginBonusStatus {
    return {
        groupId: progress.groupId,
        groupType,
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

function createLoginBonusRewardPlan(
    group: LoginBonusGroup,
    groupId: string,
    entry: LoginBonusEntry,
) {
    return createRewardGrantPlan(entry.rewards.map((reward, slot) => ({
        source: {
            groupId,
            groupType: group.groupType,
            index: entry.index,
            slot: slot + 1,
        },
        reward: toRewardGrantReward(reward),
    })))
}

function isComebackType(groupType: LoginBonusGroupType): boolean {
    return groupType === "Comeback"
        || groupType === "ComebackCn"
        || groupType === "ComebackJp"
}

function loginBonusGroupOrder(groupType: LoginBonusGroupType): number {
    return {
        Normal: 0,
        ComebackAlways: 1,
        Comeback: 2,
        ComebackCn: 3,
        ComebackJp: 4,
        ActiveUser: 5,
        Limited: 6,
    }[groupType]
}

function isEligibleForNewGroup(
    group: LoginBonusGroup,
    input: SettleLoginBonusInput,
): boolean {
    if (!isComebackType(group.groupType)) return true
    if (group.includeBeginner === false && input.isBeginner === true) return false
    if (group.conditionPeriodFromMs === null || group.conditionPeriodUntilMs === null) {
        return true
    }
    const previousLastLoginMs = input.previousLastLoginMs
    if (previousLastLoginMs === undefined || !Number.isFinite(previousLastLoginMs)) return false
    if (previousLastLoginMs < group.conditionPeriodFromMs
        || previousLastLoginMs > group.conditionPeriodUntilMs) {
        return false
    }
    return group.comebackInactivityDays === null
        || input.virtualNowMs - previousLastLoginMs >= group.comebackInactivityDays * DAY_MS
}

function linkedComebackBlocksActiveUser(
    group: LoginBonusGroup,
    groupId: string,
    catalog: LoginBonusCatalog,
    input: SettleLoginBonusInput,
    activeProgress: PlayerLoginBonusProgress | null,
    progressByGroupId: ReadonlyMap<string, PlayerLoginBonusProgress>,
): boolean {
    if (group.groupType !== "ActiveUser" || group.linkedComebackGroupId === null) return false
    if (activeProgress !== null) return false
    if (group.linkedComebackGroupId === groupId) return false
    const linked = catalog[group.linkedComebackGroupId]
    if (linked === undefined || !isComebackType(linked.groupType)) return false
    const linkedProgress = progressByGroupId.get(group.linkedComebackGroupId) ?? null
    return linkedProgress !== null || isEligibleForNewGroup(linked, input)
}

function nextEntry(
    group: LoginBonusGroup,
    progress: PlayerLoginBonusProgress | null,
): LoginBonusEntry | null {
    if (progress === null) return group.entries[0] ?? null
    const nextIndex = progress.lastGrantedIndex + 1
    const next = group.entries.find(entry => entry.index === nextIndex)
    if (next !== undefined) return next
    return group.groupType === "Normal" ? group.entries[0] ?? null : null
}

function validateInput(input: SettleLoginBonusInput): void {
    if (!Number.isSafeInteger(input.playerId) || input.playerId <= 0) {
        throw new TypeError("playerId must be a positive safe integer")
    }
    if (!Number.isFinite(input.virtualNowMs)) throw new TypeError("virtualNowMs must be finite")
    if (!Number.isSafeInteger(input.dailyResetHour)
        || input.dailyResetHour < 0
        || input.dailyResetHour > 23) {
        throw new TypeError("dailyResetHour must be an integer from 0 to 23")
    }
}

export function settleLoginBonusesSync(input: SettleLoginBonusInput): LoginBonusSettlement {
    validateInput(input)
    return getDb().transaction(() => {
        const progressRows = listPlayerLoginBonusProgressSync(input.playerId)
        const progressByGroupId = new Map(
            progressRows.map(progress => [progress.groupId, progress] as const),
        )
        const pendingRows = progressRows
            .filter(progress => progress.shownAt === null)
            .sort((left, right) => {
                const leftType = input.catalog[left.groupId]?.groupType ?? "Normal"
                const rightType = input.catalog[right.groupId]?.groupType ?? "Normal"
                return loginBonusGroupOrder(leftType) - loginBonusGroupOrder(rightType)
                    || (input.catalog[left.groupId]?.availableFromMs ?? 0)
                        - (input.catalog[right.groupId]?.availableFromMs ?? 0)
                    || left.groupId.localeCompare(right.groupId)
            })
        if (pendingRows.length > 0) {
            const bonuses = pendingRows.map(progress => (
                toStatus(progress, input.catalog[progress.groupId]?.groupType ?? "Normal")
            ))
            return { status: "pending", bonuses, bonus: bonuses[0] } as const
        }

        const businessDay = toBusinessDay(input.virtualNowMs, input.dailyResetHour)
        const latestGrantedBusinessDay = progressRows
            .map(progress => progress.lastGrantedBusinessDay)
            .sort()
            .at(-1)
        if (latestGrantedBusinessDay !== undefined && businessDay <= latestGrantedBusinessDay) {
            return { status: "none" } as const
        }

        const selected: Array<{
            groupId: string
            group: LoginBonusGroup
            entry: LoginBonusEntry
            progress: PlayerLoginBonusProgress | null
        }> = []
        const normal = selectActiveNormalLoginBonusGroup(input.catalog, input.virtualNowMs)
        const activeGroups = [
            ...(normal === null ? [] : [{ groupId: normal.groupId, group: normal.group }]),
            ...(["ComebackAlways", "Comeback", "ComebackCn", "ComebackJp", "ActiveUser", "Limited"] as const)
                .flatMap(groupType => selectActiveLoginBonusGroups(input.catalog, groupType, input.virtualNowMs)),
        ]
        for (const { groupId, group } of activeGroups) {
            const progress = progressByGroupId.get(groupId) ?? null
            if (linkedComebackBlocksActiveUser(
                group,
                groupId,
                input.catalog,
                input,
                progress,
                progressByGroupId,
            )) continue
            if (progress === null && !isEligibleForNewGroup(group, input)) continue
            const entry = nextEntry(group, progress)
            if (entry === null) continue
            selected.push({ groupId, group, entry, progress })
        }
        if (selected.length === 0) return { status: "none" } as const

        const receivedAt = Math.floor(input.virtualNowMs / 1000)
        const plan = createRewardGrantPlan(selected.flatMap(({ groupId, group, entry }) => (
            createLoginBonusRewardPlan(group, groupId, entry).entries
        )))
        const grant = executeRewardGrantPlanWithinTransactionSync(input.playerId, plan)
        const bonuses = selected.map(({ groupId, group, entry }) => {
            const progress: PlayerLoginBonusProgress = {
                playerId: input.playerId,
                groupId,
                lastGrantedIndex: entry.index,
                lastGrantedBusinessDay: businessDay,
                receivedAt,
                shownAt: null,
            }
            upsertPlayerLoginBonusProgressSync(progress)
            return toStatus(progress, group.groupType)
        })
        return { status: "granted", bonuses, bonus: bonuses[0], grant } as const
    })()
}

export function settleNormalLoginBonusSync(
    input: SettleNormalLoginBonusInput,
): NormalLoginBonusSettlement {
    const normalCatalog = Object.fromEntries(
        Object.entries(input.catalog).filter(([, group]) => group.groupType === "Normal"),
    )
    return settleLoginBonusesSync({ ...input, catalog: normalCatalog })
}

export function confirmLoginBonusesShownSync(playerId: number, virtualNowMs: number): boolean {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
        throw new TypeError("playerId must be a positive safe integer")
    }
    if (!Number.isFinite(virtualNowMs)) throw new TypeError("virtualNowMs must be finite")
    return confirmPlayerLoginBonusShownSync(playerId, Math.floor(virtualNowMs / 1000)) > 0
}

export function confirmNormalLoginBonusShownSync(playerId: number, virtualNowMs: number): boolean {
    return confirmLoginBonusesShownSync(playerId, virtualNowMs)
}

export type { PlayerNormalLoginBonusProgress }
