import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../../content/runtime/content-snapshot"
import {
    resolvePeriodicRewardPointId,
    validatePeriodicRewardTables,
    type ValidatedPeriodicRewardTables,
} from "../../content/validation/periodic-reward-output"

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
    readonly kind: 0
    readonly itemId: number
    readonly count: number
    readonly probability: number
}

const catalogs = new WeakMap<ReadonlyContentRepository, ValidatedPeriodicRewardTables>()

export function getPeriodicRewardCatalog(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): ValidatedPeriodicRewardTables {
    const cached = catalogs.get(repository)
    if (cached !== undefined) return cached
    const catalog = validatePeriodicRewardTables({
        events: repository.table("hard_multi_event.json"),
        points: repository.table("periodic_reward_point.json"),
        rewards: repository.table("periodic_reward.json"),
        quests: repository.table("hard_multi_event_quest.json"),
    })
    catalogs.set(repository, catalog)
    return catalog
}

export function getActivityPeriodicRewardPointDefinitions(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): readonly Readonly<{
    id: number
    definition: PeriodicRewardPointDefinition
}>[] {
    const catalog = getPeriodicRewardCatalog(repository)
    const pointIds = new Set<number>()
    for (const event of Object.values(catalog.events)) {
        if (event.periodicPointId !== undefined) pointIds.add(event.periodicPointId)
    }
    for (const [questId, quest] of Object.entries(catalog.quests ?? {})) {
        const eventId = Math.floor(Number(questId) / 1_000)
        if (quest.periodicRewardGroupId === undefined) continue
        const pointId = resolvePeriodicRewardPointId(
            catalog.events,
            eventId,
            quest.periodicRewardGroupId,
        )
        if (pointId !== null) pointIds.add(pointId)
    }
    return Object.freeze([...pointIds]
        .sort((left, right) => left - right)
        .map(id => Object.freeze({ id, definition: catalog.points[String(id)] })))
}

export function resolveActivityPeriodicRewardPointId(
    eventId: number,
    groupId: number,
): number | null {
    const catalog = getPeriodicRewardCatalog()
    return resolvePeriodicRewardPointId(catalog.events, eventId, groupId)
}

export function getHardMultiQuestPeriodicDefinition(
    questId: number,
): HardMultiQuestPeriodicDefinition | undefined {
    return getPeriodicRewardCatalog().quests?.[String(questId)]
}

export function getPeriodicRewardGroup(
    groupId: number,
): Readonly<Record<string, PeriodicRewardDefinition>> | undefined {
    return getPeriodicRewardCatalog().rewards[String(groupId)]
}
