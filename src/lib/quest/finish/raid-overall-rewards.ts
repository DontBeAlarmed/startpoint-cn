import raidOverallRewardAsset from "../../../../assets/raid_event_overall_reward.json"
import {
    ContentSnapshotError,
    getContentSnapshot,
} from "../../../content/runtime/content-snapshot"
import { RewardType } from "../../types"
import type { CurrencyReward, EquipmentItemReward } from "../../types"

export type RaidOverallRewardKind = "item" | "stone" | "mana"

export interface RaidOverallRewardDefinition {
    readonly id: number
    readonly eventId: number
    readonly requirement:
        | { readonly kind: "total", readonly threshold: number }
        | { readonly kind: "each", readonly start?: number, readonly interval: number }
    readonly rewards: readonly {
        readonly kind: RaidOverallRewardKind
        readonly itemId?: number
        readonly amount: number
    }[]
}

export interface RaidOverallRewardGrant {
    readonly id: number
    readonly kind: RaidOverallRewardKind
    readonly itemId?: number
    readonly amount: number
}

export function toRaidEventRewardResponse(grant: RaidOverallRewardGrant): {
    kind: number
    kind_id: number
    number: number
} {
    if (grant.kind === "item") return { kind: 1, kind_id: grant.itemId!, number: grant.amount }
    if (grant.kind === "mana") return { kind: 8, kind_id: 0, number: grant.amount }
    return { kind: 3, kind_id: 0, number: grant.amount }
}

export function toPlayerReward(grant: RaidOverallRewardGrant): EquipmentItemReward | CurrencyReward {
    if (grant.kind === "item") {
        return { type: RewardType.ITEM, id: grant.itemId!, count: grant.amount }
    }
    return {
        type: grant.kind === "mana" ? RewardType.MANA : RewardType.BEADS,
        count: grant.amount,
    }
}

function parsePositiveInteger(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "" || value === "(None)") return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function isEmptyMasterValue(value: unknown): boolean {
    return value === undefined || value === null || value === "" || value === "(None)"
}

function parseReward(
    row: readonly unknown[],
    offset: number,
): RaidOverallRewardDefinition["rewards"][number] | undefined {
    const rawKind = row[offset]
    const rawId = row[offset + 1]
    const rawAmount = row[offset + 2]
    if (isEmptyMasterValue(rawKind)) {
        if (!isEmptyMasterValue(rawId) || !isEmptyMasterValue(rawAmount)) {
            throw new Error(`invalid raid reward slot at column ${offset}`)
        }
        return undefined
    }
    const kind = Number(rawKind)
    const amount = parsePositiveInteger(row[offset + 2])
    if (!Number.isSafeInteger(kind) || kind < 0) {
        throw new Error(`invalid raid reward kind at column ${offset}`)
    }
    if (amount === undefined) throw new Error(`invalid raid reward amount at column ${offset + 2}`)
    if (kind === 0) {
        const itemId = parsePositiveInteger(row[offset + 1])
        if (itemId === undefined) throw new Error(`invalid raid reward item id at column ${offset + 1}`)
        return { kind: "item", itemId, amount }
    }
    if (kind === 2) return { kind: "stone", amount }
    if (kind === 3) return { kind: "mana", amount }
    throw new Error(`unsupported reward kind ${kind} at column ${offset}`)
}

function parseRow(id: number, row: readonly unknown[]): RaidOverallRewardDefinition | undefined {
    const eventId = parsePositiveInteger(row[0])
    const requirementKind = String(row[2] ?? "")
    const rewards = Array.from({ length: 10 }, (_, index) => parseReward(row, 7 + index * 3))
        .filter((reward): reward is RaidOverallRewardDefinition["rewards"][number] => reward !== undefined)
    if (eventId === undefined || rewards.length === 0) return undefined

    if (requirementKind === "0") {
        const threshold = parsePositiveInteger(row[3])
        return threshold === undefined
            ? undefined
            : { id, eventId, requirement: { kind: "total", threshold }, rewards }
    }
    if (requirementKind !== "1") return undefined
    const start = parsePositiveInteger(row[3])
    const interval = parsePositiveInteger(row[4])
    if (interval === undefined) return undefined
    return {
        id,
        eventId,
        requirement: { kind: "each", ...(start === undefined ? {} : { start }), interval },
        rewards,
    }
}

type RawRaidOverallRewardTable = Record<string, readonly (readonly unknown[])[]>

function getRewardTable(): RawRaidOverallRewardTable {
    try {
        return getContentSnapshot().repository.table<RawRaidOverallRewardTable>(
            "raid_event_overall_reward.json",
        )
    } catch (error) {
        if (!(error instanceof ContentSnapshotError)
            || error.code !== "CONTENT_SNAPSHOT_NOT_INITIALIZED") throw error
        return raidOverallRewardAsset as RawRaidOverallRewardTable
    }
}

export function parseRaidEventOverallRewardDefinitions(
    table: RawRaidOverallRewardTable,
): readonly RaidOverallRewardDefinition[] {
    return Object.entries(table).flatMap(([id, rows]) => {
        const parsed = Array.isArray(rows) && rows.length === 1
            ? parseRow(Number(id), rows[0])
            : undefined
        return parsed ? [parsed] : []
    })
}

export function getRaidEventOverallRewardDefinitions(eventId: number): readonly RaidOverallRewardDefinition[] {
    return parseRaidEventOverallRewardDefinitions(getRewardTable())
        .filter(definition => definition.eventId === eventId)
        .sort((left, right) => left.id - right.id)
}

export function selectRaidEventOverallRewards(
    eventDefinitions: readonly RaidOverallRewardDefinition[],
    previousTotalKillCount: number,
    newTotalKillCount: number,
): readonly RaidOverallRewardGrant[] {
    if (!Number.isSafeInteger(previousTotalKillCount)
        || !Number.isSafeInteger(newTotalKillCount)
        || newTotalKillCount <= previousTotalKillCount) return []

    const grants: RaidOverallRewardGrant[] = []
    const appendRewards = (definition: RaidOverallRewardDefinition, multiplier: number): void => {
        if (multiplier <= 0) return
        for (const reward of definition.rewards) {
            grants.push({
                id: definition.id,
                ...reward,
                amount: reward.amount * multiplier,
            })
        }
    }
    const totalRewards = eventDefinitions
        .filter((definition): definition is RaidOverallRewardDefinition & {
            requirement: { readonly kind: "total", readonly threshold: number }
        } => definition.requirement.kind === "total")
        .sort((left, right) => left.requirement.threshold - right.requirement.threshold || left.id - right.id)
    for (const definition of totalRewards) {
        if (definition.requirement.threshold <= previousTotalKillCount
            || definition.requirement.threshold > newTotalKillCount) continue
        appendRewards(definition, 1)
    }

    const automaticRewards = eventDefinitions
        .filter((definition): definition is RaidOverallRewardDefinition & {
            requirement: { readonly kind: "each", readonly start: number, readonly interval: number }
        } => definition.requirement.kind === "each" && definition.requirement.start !== undefined)
        .sort((left, right) => left.id - right.id)
    for (const definition of automaticRewards) {
        let matchedThresholds = 0
        for (let threshold = definition.requirement.start;
            threshold <= newTotalKillCount;
            threshold += definition.requirement.interval) {
            if (threshold <= previousTotalKillCount) continue
            matchedThresholds++
        }
        appendRewards(definition, matchedThresholds)
    }

    const perKillRewards = eventDefinitions.filter(definition => (
        definition.requirement.kind === "each" && definition.requirement.start === undefined
    ))
    const newKills = newTotalKillCount - previousTotalKillCount
    for (const definition of perKillRewards) {
        appendRewards(definition, newKills)
    }
    return grants
}
