import {
    ContentSnapshotError,
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../../content/runtime/content-snapshot"
import {
    bundledMissionContentRepository,
    parseMissionCatalogSource,
} from "./mission-catalog-source"

export interface MissionMasterDefinition {
    readonly category: number
    readonly missionId: number
    readonly pattern: string
    readonly eventId?: number
    readonly patternType?: number
    readonly requiresEventScope?: boolean
    readonly enableStart?: string
    readonly enableEnd?: string
    readonly row: readonly unknown[]
}

export interface MissionCatalogReward {
    readonly kind: number
    readonly amount: number
    readonly itemId?: number
    readonly characterId?: number
    readonly equipmentId?: number
    readonly degreeId?: number
}

export interface MissionCatalogStage {
    readonly stage: number
    readonly missionRewardId: number
    readonly targetProgress: number
    readonly targetClearSeconds?: number
    readonly rewards: readonly MissionCatalogReward[]
    readonly specialReward?: {
        readonly characterId: number
        readonly boardIndex: number
        readonly awakeLevel: number
    }
}

export interface MissionCatalog {
    readonly getDefinitions: (category: number) => readonly MissionMasterDefinition[]
    readonly getDefinition: (category: number, missionId: number) => MissionMasterDefinition | undefined
    readonly getMissionIds: (category: number) => readonly number[]
    readonly getDefinitionsByPattern: (pattern: string) => readonly MissionMasterDefinition[]
    readonly getRewardStages: (category: number, missionId: number) => readonly MissionCatalogStage[]
    readonly getRewardStage: (
        category: number,
        missionId: number,
        stage: number,
    ) => MissionCatalogStage | undefined
    readonly isEnabledAt: (category: number, missionId: number, at: Date, eventId?: number) => boolean
    readonly getAwakeMissionIdsByCharacter: (characterId: number | string) => readonly number[]
}

const EMPTY_DEFINITIONS: readonly MissionMasterDefinition[] = Object.freeze([])
const EMPTY_STAGES: readonly MissionCatalogStage[] = Object.freeze([])
const EMPTY_IDS: readonly number[] = Object.freeze([])

export function isMissionCatalogCategory(category: number): boolean {
    return Number.isInteger(category) && category >= 1 && category <= 10
}

function missionKey(category: number, missionId: number): string {
    return `${category}:${missionId}`
}

function stageKey(category: number, missionId: number, stage: number): string {
    return `${category}:${missionId}:${stage}`
}

function parseMasterCnTime(value: string | undefined): number | undefined {
    if (value === undefined) return undefined
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
    if (!match) return Number.NaN
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
    const local = new Date(0)
    local.setUTCFullYear(year, month - 1, day)
    local.setUTCHours(hour, minute, second, 0)
    if (local.getUTCFullYear() !== year
        || local.getUTCMonth() !== month - 1
        || local.getUTCDate() !== day
        || local.getUTCHours() !== hour
        || local.getUTCMinutes() !== minute
        || local.getUTCSeconds() !== second) return Number.NaN
    return local.getTime() - 8 * 60 * 60 * 1000
}

function positiveSafeInteger(value: unknown): number | undefined {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function isMissionMasterDefinitionEnabledAt(
    definition: MissionMasterDefinition,
    at: Date,
    eventId?: number,
): boolean {
    if (definition.requiresEventScope) {
        const definitionEventId = positiveSafeInteger(definition.eventId)
        const requestedEventId = positiveSafeInteger(eventId)
        if (definitionEventId === undefined
            || requestedEventId === undefined
            || definitionEventId !== requestedEventId) return false
    }

    const now = at.getTime()
    const start = parseMasterCnTime(definition.enableStart)
    const end = parseMasterCnTime(definition.enableEnd)
    if (!Number.isFinite(now)) return false
    if (start !== undefined && (!Number.isFinite(start) || start > now)) return false
    if (end !== undefined && (!Number.isFinite(end) || now > end)) return false
    return true
}

function compareDefinitions(left: MissionMasterDefinition, right: MissionMasterDefinition): number {
    return left.category - right.category || left.missionId - right.missionId
}

class SnapshotMissionCatalog implements MissionCatalog {
    readonly #definitionsByCategory = new Map<number, readonly MissionMasterDefinition[]>()
    readonly #definitionByMission = new Map<string, MissionMasterDefinition>()
    readonly #missionIdsByCategory = new Map<number, readonly number[]>()
    readonly #definitionsByPattern = new Map<string, readonly MissionMasterDefinition[]>()
    readonly #stagesByMission = new Map<string, readonly MissionCatalogStage[]>()
    readonly #stageByKey = new Map<string, MissionCatalogStage>()
    readonly #awakeMissionIdsByCharacter = new Map<string, readonly number[]>()

    constructor(repository: ReadonlyContentRepository) {
        const patternIndex = new Map<string, MissionMasterDefinition[]>()
        const categoryIndex = new Map<number, MissionMasterDefinition[]>()
        const awakeIndex = new Map<string, number[]>()

        for (const entry of parseMissionCatalogSource(repository)) {
            const { definition } = entry
            const key = missionKey(definition.category, definition.missionId)
            this.#definitionByMission.set(key, definition)
            this.#stagesByMission.set(key, entry.stages)
            for (const stage of entry.stages) {
                this.#stageByKey.set(stageKey(definition.category, definition.missionId, stage.stage), stage)
            }

            const categoryDefinitions = categoryIndex.get(definition.category) ?? []
            categoryDefinitions.push(definition)
            categoryIndex.set(definition.category, categoryDefinitions)

            const patternDefinitions = patternIndex.get(definition.pattern) ?? []
            patternDefinitions.push(definition)
            patternIndex.set(definition.pattern, patternDefinitions)

            if (entry.awakeCharacterId !== undefined) {
                const characterKey = String(entry.awakeCharacterId)
                const missionIds = awakeIndex.get(characterKey) ?? []
                missionIds.push(definition.missionId)
                awakeIndex.set(characterKey, missionIds)
            }
        }

        for (const [category, definitions] of categoryIndex) {
            definitions.sort((left, right) => left.missionId - right.missionId)
            const frozenDefinitions = Object.freeze(definitions)
            this.#definitionsByCategory.set(category, frozenDefinitions)
            this.#missionIdsByCategory.set(
                category,
                Object.freeze(frozenDefinitions.map(definition => definition.missionId)),
            )
        }
        for (const [pattern, definitions] of patternIndex) {
            definitions.sort(compareDefinitions)
            this.#definitionsByPattern.set(pattern, Object.freeze(definitions))
        }
        for (const [characterId, missionIds] of awakeIndex) {
            missionIds.sort((left, right) => left - right)
            this.#awakeMissionIdsByCharacter.set(characterId, Object.freeze(missionIds))
        }
    }

    getDefinitions(category: number): readonly MissionMasterDefinition[] {
        return this.#definitionsByCategory.get(category) ?? EMPTY_DEFINITIONS
    }

    getDefinition(category: number, missionId: number): MissionMasterDefinition | undefined {
        return this.#definitionByMission.get(missionKey(category, missionId))
    }

    getMissionIds(category: number): readonly number[] {
        return this.#missionIdsByCategory.get(category) ?? EMPTY_IDS
    }

    getDefinitionsByPattern(pattern: string): readonly MissionMasterDefinition[] {
        return this.#definitionsByPattern.get(pattern) ?? EMPTY_DEFINITIONS
    }

    getRewardStages(category: number, missionId: number): readonly MissionCatalogStage[] {
        return this.#stagesByMission.get(missionKey(category, missionId)) ?? EMPTY_STAGES
    }

    getRewardStage(category: number, missionId: number, stage: number): MissionCatalogStage | undefined {
        return this.#stageByKey.get(stageKey(category, missionId, stage))
    }

    isEnabledAt(category: number, missionId: number, at: Date, eventId?: number): boolean {
        const definition = this.getDefinition(category, missionId)
        if (!definition) return false
        return isMissionMasterDefinitionEnabledAt(definition, at, eventId)
    }

    getAwakeMissionIdsByCharacter(characterId: number | string): readonly number[] {
        const normalized = positiveSafeInteger(characterId)
        if (normalized === undefined) return EMPTY_IDS
        return this.#awakeMissionIdsByCharacter.get(String(normalized)) ?? EMPTY_IDS
    }
}

const catalogByRepository = new WeakMap<ReadonlyContentRepository, MissionCatalog>()
const repositoryByCatalog = new WeakMap<MissionCatalog, ReadonlyContentRepository>()

function currentRepository(): ReadonlyContentRepository {
    try {
        return getContentSnapshot().repository
    } catch (error) {
        if (error instanceof ContentSnapshotError
            && error.code === "CONTENT_SNAPSHOT_NOT_INITIALIZED") {
            return bundledMissionContentRepository
        }
        throw error
    }
}

export function getMissionCatalog(repository?: ReadonlyContentRepository): MissionCatalog {
    const selectedRepository = repository ?? currentRepository()
    const cached = catalogByRepository.get(selectedRepository)
    if (cached) return cached
    const catalog = Object.freeze(new SnapshotMissionCatalog(selectedRepository))
    catalogByRepository.set(selectedRepository, catalog)
    repositoryByCatalog.set(catalog, selectedRepository)
    return catalog
}

export function getMissionCatalogContentTable<T>(
    catalog: MissionCatalog,
    tableName: string,
): T {
    const repository = repositoryByCatalog.get(catalog)
    if (repository === undefined) throw new Error("Mission Catalog Content source not found")
    return repository.table<T>(tableName)
}

export const DEFAULT_CRAFT_POINT_ITEM_ID = 100000

export function getMissionCatalogCraftPointItemId(catalog: MissionCatalog): number {
    let config: Record<string, unknown>
    try {
        config = getMissionCatalogContentTable(catalog, "config.json")
    } catch {
        return DEFAULT_CRAFT_POINT_ITEM_ID
    }
    const itemId = Number(config.craft_point_item_id)
    return Number.isSafeInteger(itemId) && itemId > 0
        ? itemId
        : DEFAULT_CRAFT_POINT_ITEM_ID
}
