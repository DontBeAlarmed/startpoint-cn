import {
    getEpisodeChapter,
    getSecondManaBoardCharacterId,
    getSpecificCharacterBondId,
    isAuthoritativeCharacterLevelMission,
    isSecondManaBoardAggregateMission,
} from "./degree-context-requirements"
import { cloneAndFreeze } from "./degree-immutable"
import {
    getMissionCatalogContentTable,
    type MissionCatalog,
    type MissionMasterDefinition,
} from "./mission-catalog"
import { parsePositiveSafeIntegerMasterValue } from "./master-value"

export interface DegreeContentTables {
    readonly character?: unknown; readonly manaBoard?: unknown
    readonly mainQuest?: unknown; readonly exQuest?: unknown
    readonly treasureShop?: unknown; readonly bossBattleQuest?: unknown
    readonly expertSingleEventQuest?: unknown; readonly worldStoryEventQuest?: unknown
    readonly adventEventQuest?: unknown; readonly carnivalEventQuest?: unknown
    readonly hardMultiEventQuest?: unknown; readonly equipmentDissolve?: unknown
}

type RawTable = Record<string, unknown>
type TableName = keyof DegreeContentTables
const FILE_BY_TABLE: Readonly<Record<TableName, string>> = Object.freeze({
    character: "character.json", manaBoard: "mana_board.json",
    mainQuest: "main_quest.json", exQuest: "ex_quest.json",
    treasureShop: "treasure_shop.json", bossBattleQuest: "boss_battle_quest.json",
    expertSingleEventQuest: "expert_single_event_quest.json", worldStoryEventQuest: "world_story_event_quest.json",
    adventEventQuest: "advent_event_quest.json", carnivalEventQuest: "carnival_event_quest.json",
    hardMultiEventQuest: "hard_multi_event_quest.json", equipmentDissolve: "equipment_dissolve.json",
})
const QUEST_LEVELS = new Map<number, readonly [number, number]>([
    [1, [1, 19]], [2, [20, 39]], [3, [40, 69]], [4, [80, 89]],
    [5, [70, 79]], [6, [90, 99]], [7, [100, 100]],
])
const LEGACY_SUPER_IDS = new Map([["1:6", 1006003], ["1:20", 1020003]])
const TABLE_SNAPSHOTS = new WeakMap<MissionCatalog, Map<TableName, RawTable>>()

function invariant(table: TableName, definitions: readonly MissionMasterDefinition[], detail: string): Error {
    const missions = definitions.map(definition => `5:${definition.missionId}`).join(",")
    return new Error(`Degree Content invariant failed for ${FILE_BY_TABLE[table]} (${missions}): ${detail}`)
}

function asTable(
    table: TableName,
    definitions: readonly MissionMasterDefinition[],
    value: unknown,
): RawTable {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw invariant(table, definitions, "table must be a plain object")
    }
    return value as RawTable
}

const positiveInteger = parsePositiveSafeIntegerMasterValue
function isKnownMissingTable(error: unknown, fileName: string): boolean {
    return error instanceof Error
        && error.message === `unsupported bundled mission table: ${fileName}`
}
function readTable(
    catalog: MissionCatalog,
    table: TableName,
    definitions: readonly MissionMasterDefinition[],
): RawTable {
    const snapshots = TABLE_SNAPSHOTS.get(catalog) ?? new Map<TableName, RawTable>()
    TABLE_SNAPSHOTS.set(catalog, snapshots)
    const cached = snapshots.get(table)
    if (cached) return cached
    const fileName = FILE_BY_TABLE[table]
    let source: unknown
    try {
        source = getMissionCatalogContentTable(catalog, fileName)
    } catch (error) {
        if (isKnownMissingTable(error, fileName)) {
            throw invariant(table, definitions, "required table is missing")
        }
        const message = error instanceof Error ? error.message : String(error)
        throw invariant(table, definitions, `repository read failed: ${message}`)
    }
    let snapshot: RawTable
    try {
        snapshot = cloneAndFreeze(asTable(table, definitions, source))
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw invariant(table, definitions, `snapshot rejected: ${message}`)
    }
    snapshots.set(table, snapshot)
    return snapshot
}
function tableDependencies(definition: MissionMasterDefinition, catalog: MissionCatalog): readonly TableName[] {
    if (isAuthoritativeCharacterLevelMission(definition.missionId, definition, catalog)) return ["character"]
    if (getSpecificCharacterBondId(definition.missionId, definition) !== undefined) return ["character"]
    if (isSecondManaBoardAggregateMission(definition.missionId, definition)
        || getSecondManaBoardCharacterId(definition.missionId, definition) !== undefined) {
        return ["manaBoard"]
    }
    if (getEpisodeChapter(definition.missionId, definition) !== undefined) return ["mainQuest", "exQuest"]
    const conditionType = positiveInteger(definition.row[3])
    const range = positiveInteger(definition.row[8])
    if (conditionType === 45 && definition.pattern.startsWith("degree_treasure_shop_buy_count_")) return ["treasureShop"]
    if (conditionType === 14 && definition.pattern.startsWith("degree_boss_battle_ex_clear_single_")) return ["bossBattleQuest"]
    if (conditionType === 14 && range === 14) return ["expertSingleEventQuest"]
    if (conditionType === 14 && range === 9) return ["worldStoryEventQuest"]
    if (conditionType === 14 && range === 5) return ["adventEventQuest"]
    if (conditionType === 23 && range === 15) return ["carnivalEventQuest"]
    if (conditionType === 23 && range === 19) return ["hardMultiEventQuest"]
    if (conditionType === 36 && definition.pattern.startsWith("degree_equipment_lv5_get_")) {
        return ["equipmentDissolve"]
    }
    return []
}
function assertObjectRows(
    table: TableName,
    definitions: readonly MissionMasterDefinition[],
    rows: RawTable,
): void {
    for (const [rawId, row] of Object.entries(rows)) {
        if (positiveInteger(rawId) === undefined
            || row === null
            || typeof row !== "object"
            || Array.isArray(row)) {
            throw invariant(table, definitions, `invalid row ${rawId}`)
        }
    }
}

function assertCharacterTable(definitions: readonly MissionMasterDefinition[], rows: RawTable): void {
    assertObjectRows("character", definitions, rows)
    for (const [id, row] of Object.entries(rows)) {
        const rarity = positiveInteger((row as { rarity?: unknown }).rarity)
        if (rarity === undefined || rarity > 5) {
            throw invariant("character", definitions, `row ${id} has invalid rarity`)
        }
    }
}

function assertManaBoard(
    definitions: readonly MissionMasterDefinition[],
    rows: RawTable,
): void {
    assertObjectRows("manaBoard", definitions, rows)
    const selectedIds = new Set(definitions
        .map(definition => getSecondManaBoardCharacterId(definition.missionId, definition))
        .filter((id): id is number => id !== undefined)
        .map(String))
    const aggregate = definitions.some(definition => (
        isSecondManaBoardAggregateMission(definition.missionId, definition)
    ))
    const characterIds = new Set(aggregate ? Object.keys(rows) : [])
    for (const selectedId of selectedIds) characterIds.add(selectedId)
    const entries = [...characterIds].map(id => [id, rows[id]] as const)
    for (const [characterId, rawCharacter] of entries) {
        const character = rawCharacter as Record<string, unknown> | undefined
        const board = character?.["2"]
        if (board === undefined && aggregate && !selectedIds.has(characterId)) continue
        if (board === null || typeof board !== "object" || Array.isArray(board)
            || Object.keys(board).length === 0) {
            throw invariant("manaBoard", definitions, `character ${characterId} has invalid board 2`)
        }
        for (const [slot, rawRows] of Object.entries(board)) {
            if (!Array.isArray(rawRows) || !Array.isArray(rawRows[0])
                || positiveInteger(rawRows[0][0]) === undefined) {
                throw invariant("manaBoard", definitions, `character ${characterId} slot ${slot} has invalid node id`)
            }
        }
    }
}

function assertChapterTables(
    table: "mainQuest" | "exQuest",
    definitions: readonly MissionMasterDefinition[],
    rows: RawTable,
): void {
    assertObjectRows(table, definitions, rows)
    for (const definition of definitions) {
        const chapter = getEpisodeChapter(definition.missionId, definition)
        if (chapter !== undefined && !Object.keys(rows).some(id => {
            const questId = positiveInteger(id)
            return questId !== undefined && Math.floor(questId / 1_000_000) === chapter
        })) {
            throw invariant(table, [definition], `chapter ${chapter} has no quests`)
        }
    }
}

function assertExactQuestTable(
    table: Exclude<TableName, "character" | "manaBoard" | "mainQuest" | "exQuest" | "treasureShop" | "bossBattleQuest" | "equipmentDissolve">,
    definitions: readonly MissionMasterDefinition[],
    rows: RawTable,
): void {
    assertObjectRows(table, definitions, rows)
    for (const definition of definitions) {
        const eventId = positiveInteger(definition.row[9])
        const suffix = positiveInteger(definition.row[11])
        const questId = eventId === undefined || suffix === undefined
            ? undefined
            : eventId * 1000 + suffix
        if (questId === undefined || !Number.isSafeInteger(questId)
            || rows[String(questId)] === undefined) {
            throw invariant(table, [definition], `quest selector ${questId} is missing`)
        }
    }
}

function assertBossTable(definitions: readonly MissionMasterDefinition[], rows: RawTable): void {
    assertObjectRows("bossBattleQuest", definitions, rows)
    for (const definition of definitions) {
        const family = positiveInteger(definition.row[9])
        const group = positiveInteger(definition.row[10])
        const difficulty = positiveInteger(definition.row[12])
        const range = difficulty === undefined ? undefined : QUEST_LEVELS.get(difficulty)
        if (family === undefined || group === undefined || difficulty === undefined || !range) {
            throw invariant("bossBattleQuest", [definition], "mission selector is invalid")
        }
        const candidates = Object.entries(rows).filter(([rawQuestId]) => {
            const questId = positiveInteger(rawQuestId)
            return questId !== undefined
                && Math.floor(questId / 1_000_000) === family
                && Math.floor(questId / 1_000) % 1_000 === group
        })
        if (candidates.length === 0) {
            throw invariant("bossBattleQuest", [definition], "quest group is missing")
        }
        const withLevel = candidates.filter(([, row]) => (
            Object.prototype.hasOwnProperty.call(row, "enemyLevel")
        ))
        if (withLevel.length > 0) {
            if (withLevel.length !== candidates.length) {
                throw invariant("bossBattleQuest", [definition], "enemyLevel coverage is partial")
            }
            const matches = withLevel.filter(([, row]) => {
                const level = positiveInteger((row as { enemyLevel?: unknown }).enemyLevel)
                if (level === undefined) {
                    throw invariant("bossBattleQuest", [definition], "enemyLevel is invalid")
                }
                return level >= range[0] && level <= range[1]
            })
            if (matches.length !== 1) {
                throw invariant("bossBattleQuest", [definition], "enemyLevel selector is ambiguous")
            }
            continue
        }
        const questId = LEGACY_SUPER_IDS.get(`${family}:${group}`)
            ?? family * 1_000_000 + group * 1_000 + difficulty
        if (rows[String(questId)] === undefined) {
            throw invariant("bossBattleQuest", [definition], `legacy quest selector ${questId} is missing`)
        }
    }
}

function validateTable(table: TableName, definitions: readonly MissionMasterDefinition[], rows: RawTable): void {
    if (table === "character") return assertCharacterTable(definitions, rows)
    if (table === "manaBoard") return assertManaBoard(definitions, rows)
    if (table === "mainQuest" || table === "exQuest") return assertChapterTables(table, definitions, rows)
    if (table === "bossBattleQuest") return assertBossTable(definitions, rows)
    if (table === "expertSingleEventQuest" || table === "worldStoryEventQuest"
        || table === "adventEventQuest" || table === "carnivalEventQuest"
        || table === "hardMultiEventQuest") return assertExactQuestTable(table, definitions, rows)
    assertObjectRows(table, definitions, rows)
    if (table === "equipmentDissolve") {
        for (const [id, row] of Object.entries(rows)) {
            if (positiveInteger((row as { max_level?: unknown }).max_level) === undefined) {
                throw invariant(table, definitions, `row ${id} has invalid max_level`)
            }
        }
    }
}

export function loadDegreeContentTables(
    catalog: MissionCatalog,
    definitions: readonly MissionMasterDefinition[],
): DegreeContentTables {
    const definitionsByTable = new Map<TableName, MissionMasterDefinition[]>()
    for (const definition of definitions) {
        for (const table of tableDependencies(definition, catalog)) {
            const dependents = definitionsByTable.get(table) ?? []
            dependents.push(definition)
            definitionsByTable.set(table, dependents)
        }
    }
    const result: Partial<Record<TableName, unknown>> = {}
    for (const [table, dependents] of definitionsByTable) {
        const rows = readTable(catalog, table, dependents)
        validateTable(table, dependents, rows)
        result[table] = rows
    }
    return Object.freeze(result)
}

export function asDegreeTable(value: unknown): RawTable | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as RawTable
        : undefined
}
