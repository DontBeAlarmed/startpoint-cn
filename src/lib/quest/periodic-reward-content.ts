import { getContentSnapshot, type ReadonlyContentRepository } from "../../content/runtime/content-snapshot"

export interface PeriodicRewardPointDefinition {
    readonly maxPoint: number
    readonly recoveryPoint: number
    readonly recoveryCycle: number
}

export interface HardMultiQuestPeriodicDefinition {
    readonly periodicRewardGroupId?: number
    readonly periodicRewardSlots?: number
}

export interface PeriodicRewardDefinition {
    readonly kind: number
    readonly itemId: number
    readonly count: number
    readonly probability: number
}

interface HardMultiEventTable {
    readonly [eventId: string]: { readonly periodicPointId?: number }
}

interface HardMultiQuestTable {
    readonly [questId: string]: HardMultiQuestPeriodicDefinition
}

interface PeriodicRewardPointTable {
    readonly [pointId: string]: PeriodicRewardPointDefinition
}

interface PeriodicRewardTable {
    readonly [groupId: string]: Readonly<Record<string, PeriodicRewardDefinition>>
}

const FINAL_OPERATION_EVENT_IDS = new Set([1001, 1002, 1003, 1004, 1005, 1006])

const pointDefinitionsByRepository = new WeakMap<
    ReadonlyContentRepository,
    ReadonlyMap<number, PeriodicRewardPointDefinition>
>()

function getRepository(): ReadonlyContentRepository {
    return getContentSnapshot().repository
}

/**
 * Activity periodic reward schedule: HardMulti events map to periodic point
 * definitions, with the final-operation events additionally pulling group ids
 * from their quest table.
 */
export function getActivityPeriodicRewardPointDefinitions(): ReadonlyMap<
    number,
    PeriodicRewardPointDefinition
> {
    const repository = getRepository()
    const cached = pointDefinitionsByRepository.get(repository)
    if (cached) return cached

    const events = repository.table<HardMultiEventTable>("hard_multi_event.json")
    const points = repository.table<PeriodicRewardPointTable>("periodic_reward_point.json")
    const quests = repository.table<HardMultiQuestTable>("hard_multi_event_quest.json")

    const definitions = new Map<number, PeriodicRewardPointDefinition>()
    for (const event of Object.values(events)) {
        if (event.periodicPointId === undefined) continue
        const definition = points[String(event.periodicPointId)]
        if (definition !== undefined) definitions.set(event.periodicPointId, definition)
    }
    for (const [questId, quest] of Object.entries(quests)) {
        if (!FINAL_OPERATION_EVENT_IDS.has(Math.floor(Number(questId) / 1000))) continue
        const pointId = quest.periodicRewardGroupId
        if (pointId === undefined || definitions.has(pointId)) continue
        const definition = points[String(pointId)]
        if (definition !== undefined) definitions.set(pointId, definition)
    }
    const frozen = Object.freeze(definitions)
    pointDefinitionsByRepository.set(repository, frozen)
    return frozen
}

export function resolveActivityPeriodicRewardPointId(
    eventId: number,
    groupId: number,
): number | null {
    const events = getRepository().table<HardMultiEventTable>("hard_multi_event.json")
    const configured = events[String(eventId)]?.periodicPointId
    if (configured !== undefined) return configured
    return FINAL_OPERATION_EVENT_IDS.has(eventId) ? groupId : null
}

export function getHardMultiQuestPeriodicDefinition(
    questId: number,
): HardMultiQuestPeriodicDefinition | undefined {
    return getRepository().table<HardMultiQuestTable>("hard_multi_event_quest.json")[String(questId)]
}

export function getPeriodicRewardGroup(
    groupId: number,
): Readonly<Record<string, PeriodicRewardDefinition>> | undefined {
    return getRepository().table<PeriodicRewardTable>("periodic_reward.json")[String(groupId)]
}
