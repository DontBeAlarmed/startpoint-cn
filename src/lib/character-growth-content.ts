import {
    parseCharacterLevelTable,
    getCharacterLevelByExperience,
    type CharacterLevelTable,
} from "../content/character-mana-admission"
import { deepFreeze } from "../content/deep-freeze"
import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../content/runtime/content-snapshot"
import { GameCalendarError, type GameCalendarPolicy } from "../time/game-calendar"
import { getGameCalendar } from "../time/game-calendar-provider"
import { buildCharacterManaMutationContent } from "./character-mana-mutation-content"
import type { CharacterManaMutationContent } from "./character-mana-mutation-types"
import type { ManaNode } from "./types"

export interface ManaNodeAwakeCost {
    manaAmount: number
    items: Record<string, number>
}

export interface ManaBoard2OpenCondition {
    readonly startTime: Date
    readonly endTime: Date
}

/**
 * Limited static Growth content: mana boards/nodes, awake costs, level
 * thresholds and the mana mutation content used by growth commands. Player
 * character state (learned nodes, awake levels, exp) stays with the
 * Character owner and is never read here.
 */
export interface CharacterGrowthContent {
    getManaBoardCount(characterId: number | string): number
    getManaBoardNodes(
        characterId: number | string,
        level: number | string,
    ): Readonly<Record<string, ManaNode>> | null
    getManaNode(
        characterId: number | string,
        level: number | string,
        manaNodeId: number | string,
    ): ManaNode | null
    /** Slot (1-4) from field6: 1/2/3 → ability slots, empty → skill slot 4; 0 when unknown. */
    getManaNodeSlot(characterId: number | string, manaNodeId: number | string): number
    /** Pedestal size (0 or 2) from mana_board rows; -1 when unknown. */
    getManaNodePedestalSize(characterId: number | string, manaNodeId: number | string): number
    /** Awake cost lookup: mana_node_awake[rarity][slot][pedestal_size]; null when unknown. */
    getManaNodeAwakeCost(
        characterId: number | string,
        manaNodeId: number | string,
        rarity: number,
    ): ManaNodeAwakeCost | null
    getLevelByExperience(characterRarity: number, experience: number): number
    buildManaMutationContent(
        characterId: number,
        boardId: number,
    ): CharacterManaMutationContent
    /** Number of characters whose content defines a second mana board. */
    getSecondBoardCharacterCount(): number
    /** Official second-board open windows keyed by character id. */
    getSecondBoardOpenConditions(): ReadonlyMap<number, ManaBoard2OpenCondition>
}

interface ManaNodeTable {
    readonly [characterId: string]: {
        readonly [level: string]: Record<string, ManaNode>
    }
}

type ManaBoardTable = Record<string, Record<string, Record<string, readonly unknown[][]>>>
type ManaNodeAwakeTable = Record<string, Record<string, Record<string, readonly unknown[][]>>>

function table<T>(repository: ReadonlyContentRepository, tableName: string): T {
    const value = repository.table<T>(tableName)
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`Invalid growth content table ${tableName}.`)
    }
    return value
}

function parseCanonicalNonNegativeInteger(value: unknown): number | null {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
}

// Strict shape/validity checking is delegated to GameCalendarPolicy; the
// historical "JST" name follows the master-data column semantics, while the
// actual offset is the CN client's fixed calendar offset (UTC+8).
function parseJstDate(value: unknown, field: string, calendar: GameCalendarPolicy): Date {
    if (typeof value !== "string") throw new Error(`${field} must be a JST date string`)
    try {
        return new Date(calendar.parseMasterTimestamp(value))
    } catch (error) {
        if (error instanceof GameCalendarError) {
            throw new Error(`${field} has an invalid JST date format`)
        }
        throw error
    }
}

export function parseManaBoard2OpenConditionTable(
    table: Record<string, unknown>,
    calendar: GameCalendarPolicy = getGameCalendar(),
): ReadonlyMap<number, ManaBoard2OpenCondition> {
    if (!table || typeof table !== "object" || Array.isArray(table)) {
        throw new Error("mana_board2_open_condition table must be an object")
    }
    const result = new Map<number, ManaBoard2OpenCondition>()
    for (const [characterIdText, rawRows] of Object.entries(table)) {
        const characterId = Number(characterIdText)
        if (!Number.isSafeInteger(characterId) || characterId <= 0
            || !Array.isArray(rawRows) || rawRows.length !== 1
            || !Array.isArray(rawRows[0]) || rawRows[0].length !== 2) {
            throw new Error(`mana_board2_open_condition row ${characterIdText} is malformed`)
        }
        const startTime = parseJstDate(rawRows[0][0], `row ${characterIdText} start_time`, calendar)
        const endTime = parseJstDate(rawRows[0][1], `row ${characterIdText} end_time`, calendar)
        if (startTime.getTime() > endTime.getTime()) {
            throw new Error(`mana_board2_open_condition row ${characterIdText} has an inverted range`)
        }
        result.set(characterId, Object.freeze({ startTime, endTime }))
    }
    return result
}

function parseCanonicalPositiveInteger(value: unknown): number | null {
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
}

export function buildCharacterGrowthContent(
    repository: ReadonlyContentRepository,
    calendar: GameCalendarPolicy = getGameCalendar(),
): CharacterGrowthContent {
    const manaNodes = table<ManaNodeTable>(repository, "mana_node.json")
    const manaBoard = table<ManaBoardTable>(repository, "mana_board.json")
    const manaNodeAwake = table<ManaNodeAwakeTable>(repository, "mana_node_awake.json")
    const levelTable: CharacterLevelTable = parseCharacterLevelTable(
        table<unknown>(repository, "character_level.json"),
    )
    const levelRequirements = table<unknown>(repository, "level_required_mana_node.json")
    let secondBoardOpenConditions: ReadonlyMap<number, ManaBoard2OpenCondition> | null = null

    const getManaNodeSlot = (
        characterId: number | string,
        manaNodeId: number | string,
    ): number => {
        const charData = manaNodes[String(characterId)]
        if (!charData) return 0
        for (const level of Object.keys(charData)) {
            const node = charData[level]?.[String(manaNodeId)]
            if (node) {
                const f6 = node.field6
                if (f6 === "1") return 1
                if (f6 === "2") return 2
                if (f6 === "3") return 3
                return 4 // empty → action skill slot
            }
        }
        return 0
    }

    const getManaNodePedestalSize = (
        characterId: number | string,
        manaNodeId: number | string,
    ): number => {
        const charBoard = manaBoard[String(characterId)]
        if (!charBoard) return -1
        for (const level of Object.keys(charBoard)) {
            const nodes = charBoard[level]
            for (const nodeIndex of Object.keys(nodes)) {
                const row = nodes[nodeIndex][0]
                if (String(row[0]) === String(manaNodeId)) {
                    return parseInt(row[4] as string) || 0
                }
            }
        }
        return -1
    }

    const getManaNodeAwakeCost = (
        characterId: number | string,
        manaNodeId: number | string,
        rarity: number,
    ): ManaNodeAwakeCost | null => {
        const slot = getManaNodeSlot(characterId, manaNodeId)
        if (slot === 0) return null

        const pedestalSize = getManaNodePedestalSize(characterId, manaNodeId)
        if (pedestalSize < 0) return null

        const rarityData = manaNodeAwake[String(rarity)]
        if (!rarityData) return null

        const slotData = rarityData[String(slot)]
        if (!slotData) return null

        const targetRows = slotData[String(pedestalSize)]
        if (!targetRows || !targetRows[0]) return null

        const row = targetRows[0]
        if (!Array.isArray(row) || row.length < 3) return null
        // row[0]: "item_id_1,item_id_2,..." (IDs)
        // row[1]: "count_1,count_2,..." (counts)
        // row[2]: mana amount
        if (typeof row[0] !== "string" || typeof row[1] !== "string") return null
        const idStrings = row[0].split(",")
        const countStrings = row[1].split(",")
        if (idStrings.length === 0 || idStrings.length !== countStrings.length) return null
        const manaAmount = parseCanonicalNonNegativeInteger(row[2])
        if (manaAmount === null) return null

        const items: Record<string, number> = {}
        for (let i = 0; i < idStrings.length; i++) {
            const id = parseCanonicalPositiveInteger(idStrings[i])
            const count = parseCanonicalPositiveInteger(countStrings[i])
            if (id === null || count === null) return null
            const nextAmount = (items[String(id)] || 0) + count
            if (!Number.isSafeInteger(nextAmount)) return null
            items[String(id)] = nextAmount
        }

        return deepFreeze({ manaAmount, items: deepFreeze(items) })
    }

    const content: CharacterGrowthContent = {
        getManaBoardCount: characterId => {
            const characterManaNodes = manaNodes[String(characterId)]
            if (!characterManaNodes) return 0
            return Object.keys(characterManaNodes).length
        },
        getManaBoardNodes: (characterId, level) => (
            manaNodes[String(characterId)]?.[String(level)] ?? null
        ),
        getManaNode: (characterId, level, manaNodeId) => (
            manaNodes[String(characterId)]?.[String(level)]?.[String(manaNodeId)] ?? null
        ),
        getManaNodeSlot,
        getManaNodePedestalSize,
        getManaNodeAwakeCost,
        getLevelByExperience: (characterRarity, experience) => getCharacterLevelByExperience(
            levelTable,
            characterRarity,
            experience,
        ),
        buildManaMutationContent: (characterId, boardId) => buildCharacterManaMutationContent(
            characterId,
            boardId,
            {
                manaNodes: manaNodes as unknown as Record<string, Record<string, Record<string, ManaNode>>>,
                manaBoard,
                levelRequirements,
            },
        ),
        getSecondBoardCharacterCount: () => (
            Object.values(manaBoard)
                .filter(board => board !== null && typeof board === "object"
                    && board["2"] !== undefined)
                .length
        ),
        getSecondBoardOpenConditions: () => {
            if (secondBoardOpenConditions === null) {
                secondBoardOpenConditions = parseManaBoard2OpenConditionTable(
                    table<Record<string, unknown>>(repository, "mana_board2_open_condition.json"),
                    calendar,
                )
            }
            return secondBoardOpenConditions
        },
    }
    return Object.freeze(content)
}

const contentByRepository = new WeakMap<ReadonlyContentRepository, CharacterGrowthContent>()

export function getCharacterGrowthContent(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): CharacterGrowthContent {
    const cached = contentByRepository.get(repository)
    if (cached !== undefined) return cached
    const content = buildCharacterGrowthContent(repository)
    contentByRepository.set(repository, content)
    return content
}
