import raidOverallRewardAsset from "../../../../assets/raid_event_overall_reward.json"
import { RewardType } from "../../types"
import type { CurrencyReward, EquipmentItemReward } from "../../types"

export type RaidOverallRewardKind = "item" | "stone" | "mana"

export interface RaidOverallRewardDefinition {
    readonly id: number
    readonly eventId: number
    readonly requirement:
        | { readonly kind: "total", readonly threshold: number }
        | { readonly kind: "each", readonly start?: number, readonly interval: number }
    readonly reward: {
        readonly kind: RaidOverallRewardKind
        readonly itemId?: number
        readonly amount: number
    }
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

function parseReward(row: readonly unknown[]): RaidOverallRewardDefinition["reward"] | undefined {
    const kind = Number(row[7])
    const amount = parsePositiveInteger(row[9])
    if (!Number.isSafeInteger(kind) || kind < 0 || amount === undefined) return undefined
    if (kind === 0) {
        const itemId = parsePositiveInteger(row[8])
        return itemId === undefined ? undefined : { kind: "item", itemId, amount }
    }
    if (kind === 2) return { kind: "stone", amount }
    if (kind === 3) return { kind: "mana", amount }
    return undefined
}

function parseRow(id: number, row: readonly unknown[]): RaidOverallRewardDefinition | undefined {
    const eventId = parsePositiveInteger(row[0])
    const requirementKind = String(row[2] ?? "")
    const reward = parseReward(row)
    if (eventId === undefined || reward === undefined) return undefined

    if (requirementKind === "0") {
        const threshold = parsePositiveInteger(row[3])
        return threshold === undefined
            ? undefined
            : { id, eventId, requirement: { kind: "total", threshold }, reward }
    }
    if (requirementKind !== "1") return undefined
    const start = parsePositiveInteger(row[3])
    const interval = parsePositiveInteger(row[4])
    if (interval === undefined) return undefined
    return {
        id,
        eventId,
        requirement: { kind: "each", ...(start === undefined ? {} : { start }), interval },
        reward,
    }
}

const definitions: readonly RaidOverallRewardDefinition[] = Object.entries(
    raidOverallRewardAsset as Record<string, readonly (readonly unknown[])[]>,
).flatMap(([id, rows]) => {
    const parsed = Array.isArray(rows) && rows.length === 1
        ? parseRow(Number(id), rows[0])
        : undefined
    return parsed ? [parsed] : []
})

export function getRaidEventOverallRewardDefinitions(eventId: number): readonly RaidOverallRewardDefinition[] {
    return definitions
        .filter(definition => definition.eventId === eventId)
        .sort((left, right) => left.id - right.id)
}

export function selectRaidEventOverallRewards(
    eventDefinitions: readonly RaidOverallRewardDefinition[],
    previousTotalKillCount: number,
    newTotalKillCount: number,
    killCountWeight: number,
): readonly RaidOverallRewardGrant[] {
    if (!Number.isSafeInteger(previousTotalKillCount)
        || !Number.isSafeInteger(newTotalKillCount)
        || newTotalKillCount <= previousTotalKillCount) return []

    const grants: RaidOverallRewardGrant[] = []
    const totalRewards = eventDefinitions
        .filter((definition): definition is RaidOverallRewardDefinition & {
            requirement: { readonly kind: "total", readonly threshold: number }
        } => definition.requirement.kind === "total")
        .sort((left, right) => left.requirement.threshold - right.requirement.threshold || left.id - right.id)
    for (const definition of totalRewards) {
        if (definition.requirement.threshold <= previousTotalKillCount
            || definition.requirement.threshold > newTotalKillCount) continue
        grants.push({ id: definition.id, ...definition.reward })
    }

    const automaticRewards = eventDefinitions
        .filter((definition): definition is RaidOverallRewardDefinition & {
            requirement: { readonly kind: "each", readonly start: number, readonly interval: number }
        } => definition.requirement.kind === "each" && definition.requirement.start !== undefined)
        .sort((left, right) => left.id - right.id)
    for (const definition of automaticRewards) {
        for (let threshold = definition.requirement.start;
            threshold <= newTotalKillCount;
            threshold += definition.requirement.interval) {
            if (threshold <= previousTotalKillCount) continue
            grants.push({ id: definition.id, ...definition.reward })
        }
    }

    const perKillRewards = eventDefinitions.filter(definition => (
        definition.requirement.kind === "each" && definition.requirement.start === undefined
    ))
    if (killCountWeight > 0) {
        for (const definition of perKillRewards) {
            grants.push({
                id: definition.id,
                ...definition.reward,
                amount: definition.reward.amount * killCountWeight,
            })
        }
    }
    return grants
}
