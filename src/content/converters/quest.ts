import { deepFreeze } from "../deep-freeze"
import {
    convertOrderedMapJson,
    type CsvOrderedMapTree,
} from "./ordered-map-json"

export const QUEST_TABLE_SOURCES = Object.freeze({
    "main_quest.json": { logicalPath: "master/quest/main_quest.orderedmap", nestingDepth: 3 },
    "ex_quest.json": { logicalPath: "master/quest/ex_quest.orderedmap", nestingDepth: 3 },
    "boss_battle_quest.json": { logicalPath: "master/quest/boss_battle_quest.orderedmap", nestingDepth: 3 },
    "character_quest.json": { logicalPath: "master/quest/character_quest.orderedmap", nestingDepth: 1 },
    "world_story_event_quest.json": { logicalPath: "master/quest/event/world_story_event_quest.orderedmap", nestingDepth: 2 },
    "world_story_event_boss_battle_quest.json": { logicalPath: "master/quest/event/world_story_event_boss_battle_quest.orderedmap", nestingDepth: 2 },
    "advent_event_quest.json": { logicalPath: "master/quest/event/advent_event_quest.orderedmap", nestingDepth: 2 },
    "daily_exp_mana_event_quest.json": { logicalPath: "master/quest/event/daily_exp_mana_event_quest.orderedmap", nestingDepth: 2 },
    "daily_week_event_quest.json": { logicalPath: "master/quest/event/daily_week_event_quest.orderedmap", nestingDepth: 2 },
    "challenge_dungeon_event_quest.json": { logicalPath: "master/quest/event/challenge_dungeon_event_quest.orderedmap", nestingDepth: 2 },
    "story_event_single_quest.json": { logicalPath: "master/quest/event/story_event_single_quest.orderedmap", nestingDepth: 2 },
    "ranking_event_single_quest.json": { logicalPath: "master/quest/event/ranking_event_single_quest.orderedmap", nestingDepth: 2 },
    "solo_time_attack_event_quest.json": { logicalPath: "master/quest/event/solo_time_attack_event_quest.orderedmap", nestingDepth: 2 },
    "tower_dungeon_event_quest.json": { logicalPath: "master/quest/event/tower_dungeon_event_quest.orderedmap", nestingDepth: 2 },
    "expert_single_event_quest.json": { logicalPath: "master/quest/event/expert_single_event_quest.orderedmap", nestingDepth: 2 },
    "carnival_event_quest.json": { logicalPath: "master/quest/event/carnival_event_quest.orderedmap", nestingDepth: 2 },
    "rush_event_quest.json": { logicalPath: "master/quest/event/rush_event_quest.orderedmap", nestingDepth: 2 },
    "raid_event_quest.json": { logicalPath: "master/quest/event/raid_event_quest.orderedmap", nestingDepth: 2 },
    "score_attack_event_quest.json": { logicalPath: "master/quest/event/score_attack_event_quest.orderedmap", nestingDepth: 2 },
    "hard_multi_event_quest.json": { logicalPath: "master/quest/event/hard_multi_event_quest.orderedmap", nestingDepth: 2 },
} as const)

export const QUEST_AUXILIARY_SOURCES = Object.freeze({
    dailyChallengePoint: "master/quest/event/daily_challenge_point.orderedmap",
    expertSingleEvent: "master/quest/event/expert_single_event.orderedmap",
    soloTimeAttackEvent: "master/quest/event/solo_time_attack_event.orderedmap",
    practiceQuest: "master/quest/practice/practice_quest.orderedmap",
} as const)

export type QuestTableName = keyof typeof QUEST_TABLE_SOURCES
export type QuestDerivedTableName =
    | "daily_challenge_point_lookup.json"
    | "event_challenge_point_map.json"
    | "quest_entry_costs.json"
    | "quest_lookup.json"
    | "quest_unlock_costs.json"
export type QuestConversionOutput = Readonly<Record<
    QuestTableName | QuestDerivedTableName,
    Readonly<Record<string, unknown>>
>>

export interface QuestSourceReader {
    readDynamic(logicalPath: string): Promise<Buffer>
}

export interface QuestConversionCompatibility {
    readonly practiceQuests: Readonly<Record<string, { readonly name?: unknown }>>
}

interface QuestRow {
    readonly path: readonly string[]
    readonly fields: readonly string[]
}

interface StandardLayout {
    readonly minimumColumns: number
    readonly clearReward?: number
    readonly sPlusReward?: number
    readonly storyClearReward?: number
    readonly scoreGroup?: number
    readonly commonRewardCount?: number | readonly [number, number, number, number, number]
    readonly element?: number
    readonly enemyLevel?: number
    readonly rankTimes: readonly [number, number, number, number] | "zero"
    readonly rewards: readonly [number, number, number, number]
    readonly fixedParty?: number
    readonly storyCheck?: number
    readonly isBothBoss?: number
    readonly hardcodeClearReward?: boolean
}

interface QuestDerivationLayout {
    readonly category: number
    readonly name: number
    readonly stamina: number
    readonly entryItem: readonly [mode: number, itemId: number, itemCount: number]
}

const QUEST_DERIVATION_LAYOUTS: Readonly<Record<QuestTableName, QuestDerivationLayout>> = {
    "main_quest.json": { category: 1, name: 1, stamina: 69, entryItem: [55, 56, 57] },
    "boss_battle_quest.json": { category: 2, name: 2, stamina: 69, entryItem: [55, 56, 57] },
    "character_quest.json": { category: 3, name: 3, stamina: 71, entryItem: [57, 58, 59] },
    "ex_quest.json": { category: 4, name: 1, stamina: 69, entryItem: [55, 56, 57] },
    "daily_week_event_quest.json": { category: 6, name: 1, stamina: 64, entryItem: [50, 51, 52] },
    "advent_event_quest.json": { category: 7, name: 2, stamina: 75, entryItem: [61, 62, 63] },
    "story_event_single_quest.json": { category: 10, name: 2, stamina: 71, entryItem: [57, 58, 59] },
    "ranking_event_single_quest.json": { category: 11, name: 2, stamina: 66, entryItem: [52, 53, 54] },
    "challenge_dungeon_event_quest.json": { category: 13, name: 2, stamina: 70, entryItem: [56, 57, 58] },
    "daily_exp_mana_event_quest.json": { category: 14, name: 2, stamina: 65, entryItem: [51, 52, 53] },
    "world_story_event_quest.json": { category: 18, name: 2, stamina: 70, entryItem: [56, 57, 58] },
    "world_story_event_boss_battle_quest.json": { category: 19, name: 2, stamina: 69, entryItem: [55, 56, 57] },
    "tower_dungeon_event_quest.json": { category: 20, name: 2, stamina: 68, entryItem: [54, 55, 56] },
    "expert_single_event_quest.json": { category: 21, name: 4, stamina: 72, entryItem: [58, 59, 60] },
    "carnival_event_quest.json": { category: 22, name: 4, stamina: 67, entryItem: [53, 54, 55] },
    "raid_event_quest.json": { category: 23, name: 4, stamina: 68, entryItem: [54, 55, 56] },
    "rush_event_quest.json": { category: 24, name: 4, stamina: 67, entryItem: [53, 54, 55] },
    "solo_time_attack_event_quest.json": { category: 25, name: 3, stamina: 70, entryItem: [56, 57, 58] },
    "hard_multi_event_quest.json": { category: 26, name: 2, stamina: 70, entryItem: [56, 57, 58] },
    "score_attack_event_quest.json": { category: 27, name: 4, stamina: 71, entryItem: [57, 58, 59] },
}

const STANDARD_LAYOUTS: Readonly<Partial<Record<QuestTableName, StandardLayout>>> = {
    "main_quest.json": {
        minimumColumns: 119,
        clearReward: 3,
        sPlusReward: 71,
        scoreGroup: 70,
        commonRewardCount: [88, 89, 90, 91, 92],
        element: 72,
        enemyLevel: 106,
        rankTimes: [84, 85, 86, 87],
        rewards: [93, 94, 95, 96],
        fixedParty: 118,
        storyCheck: 84,
    },
    "ex_quest.json": {
        minimumColumns: 119,
        clearReward: 3,
        sPlusReward: 71,
        scoreGroup: 70,
        commonRewardCount: [88, 89, 90, 91, 92],
        element: 72,
        enemyLevel: 106,
        rankTimes: [84, 85, 86, 87],
        rewards: [93, 94, 95, 96],
        fixedParty: 118,
        storyCheck: 84,
    },
    "boss_battle_quest.json": {
        minimumColumns: 123,
        clearReward: 4,
        sPlusReward: 71,
        storyClearReward: 3,
        scoreGroup: 70,
        commonRewardCount: [88, 89, 90, 91, 92],
        element: 72,
        enemyLevel: 106,
        rankTimes: [84, 85, 86, 87],
        rewards: [93, 94, 95, 96],
        storyCheck: 84,
        isBothBoss: 122,
    },
    "world_story_event_quest.json": {
        minimumColumns: 120,
        clearReward: 4,
        sPlusReward: 72,
        scoreGroup: 71,
        commonRewardCount: [89, 90, 91, 92, 93],
        element: 73,
        enemyLevel: 107,
        rankTimes: [85, 86, 87, 88],
        rewards: [94, 95, 96, 97],
        fixedParty: 119,
        storyCheck: 85,
    },
    "world_story_event_boss_battle_quest.json": {
        minimumColumns: 98,
        clearReward: 4,
        sPlusReward: 71,
        scoreGroup: 70,
        commonRewardCount: [88, 89, 90, 91, 92],
        element: 72,
        enemyLevel: 106,
        rankTimes: [84, 85, 86, 87],
        rewards: [93, 94, 95, 96],
    },
    "advent_event_quest.json": {
        minimumColumns: 103,
        clearReward: 4,
        sPlusReward: 77,
        scoreGroup: 76,
        commonRewardCount: [94, 95, 96, 97, 98],
        element: 78,
        enemyLevel: 112,
        rankTimes: [90, 91, 92, 93],
        rewards: [99, 100, 101, 102],
        storyCheck: 90,
    },
    "daily_exp_mana_event_quest.json": {
        minimumColumns: 72,
        clearReward: 4,
        scoreGroup: 66,
        commonRewardCount: 67,
        rankTimes: "zero",
        rewards: [68, 69, 70, 71],
    },
    "daily_week_event_quest.json": {
        minimumColumns: 71,
        clearReward: 3,
        scoreGroup: 65,
        commonRewardCount: 66,
        rankTimes: "zero",
        rewards: [67, 68, 69, 70],
    },
    "challenge_dungeon_event_quest.json": {
        minimumColumns: 98,
        clearReward: 4,
        sPlusReward: 72,
        scoreGroup: 71,
        commonRewardCount: [89, 90, 91, 92, 93],
        element: 73,
        enemyLevel: 107,
        rankTimes: [85, 86, 87, 88],
        rewards: [94, 95, 96, 97],
    },
    "story_event_single_quest.json": {
        minimumColumns: 99,
        clearReward: 4,
        sPlusReward: 73,
        scoreGroup: 72,
        commonRewardCount: [90, 91, 92, 93, 94],
        element: 74,
        enemyLevel: 108,
        rankTimes: [86, 87, 88, 89],
        rewards: [95, 96, 97, 98],
        storyCheck: 86,
    },
    "solo_time_attack_event_quest.json": {
        minimumColumns: 89,
        clearReward: 5,
        scoreGroup: 71,
        commonRewardCount: 84,
        element: 72,
        enemyLevel: 98,
        rankTimes: [51, 52, 53, 54],
        rewards: [85, 86, 87, 88],
    },
    "tower_dungeon_event_quest.json": {
        minimumColumns: 87,
        clearReward: 4,
        scoreGroup: 69,
        commonRewardCount: 82,
        element: 70,
        enemyLevel: 96,
        rankTimes: "zero",
        rewards: [83, 84, 85, 86],
    },
    "expert_single_event_quest.json": {
        minimumColumns: 100,
        clearReward: 6,
        sPlusReward: 74,
        scoreGroup: 73,
        commonRewardCount: [91, 92, 93, 94, 95],
        element: 75,
        enemyLevel: 109,
        rankTimes: [87, 88, 89, 90],
        rewards: [96, 97, 98, 99],
    },
    "raid_event_quest.json": {
        minimumColumns: 87,
        clearReward: 6,
        scoreGroup: 69,
        commonRewardCount: 82,
        element: 70,
        enemyLevel: 96,
        rankTimes: "zero",
        rewards: [83, 84, 85, 86],
    },
}

function invalidQuest(tableName: string, reason: string): never {
    throw new Error(`invalid quest content in ${tableName}: ${reason}`)
}

function isMissing(value: string | undefined): boolean {
    return value === undefined || value === "" || value === "(None)"
}

function requireColumns(tableName: string, fields: readonly string[], minimum: number): void {
    if (fields.length < minimum) {
        invalidQuest(tableName, `row must have at least ${minimum} columns, got ${fields.length}`)
    }
}

function parseInteger(tableName: string, value: string | undefined, field: string): number {
    if (value === undefined || !/^(?:0|-?[1-9]\d*)$/.test(value)) {
        invalidQuest(tableName, `${field} must be an integer: ${String(value)}`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalidQuest(tableName, `${field} is not a safe integer`)
    return parsed
}

function parseNumericInteger(tableName: string, value: string | undefined, field: string): number {
    if (value === undefined || value.trim() !== value || value === "") {
        invalidQuest(tableName, `${field} must be numeric`)
    }
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || !Number.isSafeInteger(Math.trunc(parsed))) {
        invalidQuest(tableName, `${field} must be a finite safe number`)
    }
    return Math.trunc(parsed)
}

function optionalInteger(
    tableName: string,
    value: string | undefined,
    field: string,
): number | undefined {
    return isMissing(value) ? undefined : parseInteger(tableName, value, field)
}

function parseMilliseconds(tableName: string, value: string | undefined, field: string): number {
    if (isMissing(value)) return 0
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) invalidQuest(tableName, `${field} must be a finite number`)
    const milliseconds = Math.floor(parsed * 1000)
    if (!Number.isSafeInteger(milliseconds)) invalidQuest(tableName, `${field} is out of range`)
    return milliseconds
}

function parseBoolean(tableName: string, value: string | undefined, field: string): boolean {
    if (value === "true" || value === "True" || value === "TRUE") return true
    if (value === "false" || value === "False" || value === "FALSE") return false
    return invalidQuest(tableName, `${field} must be true or false`)
}

function parseNonNegativeInteger(
    tableName: string,
    value: string | undefined,
    field: string,
): number {
    if (isMissing(value)) return 0
    const parsed = parseInteger(tableName, value, field)
    if (parsed < 0) invalidQuest(tableName, `${field} must not be negative`)
    return parsed
}

function parseIntegerList(
    tableName: string,
    value: string | undefined,
    field: string,
): readonly number[] {
    if (isMissing(value)) return Object.freeze([])
    return Object.freeze((value as string).split(",").map((part, index) => {
        const parsed = parseNonNegativeInteger(tableName, part, `${field}[${index}]`)
        if (parsed === 0) invalidQuest(tableName, `${field}[${index}] must be positive`)
        return parsed
    }))
}

function collectRows(
    tableName: string,
    tree: CsvOrderedMapTree,
    expectedDepth: number,
): QuestRow[] {
    const rows: QuestRow[] = []
    function visit(node: CsvOrderedMapTree | readonly (readonly string[])[], path: string[]): void {
        if (Array.isArray(node)) {
            if (path.length !== expectedDepth || node.length === 0) {
                invalidQuest(tableName, `unexpected leaf at depth ${path.length}`)
            }
            for (const fields of node) {
                if (!Array.isArray(fields)) invalidQuest(tableName, "leaf row must be an array")
                rows.push({ path: Object.freeze([...path]), fields })
            }
            return
        }
        for (const [key, child] of Object.entries(node)) {
            visit(child, [...path, key])
        }
    }
    visit(tree, [])
    return rows
}

function addOptional(
    output: Record<string, unknown>,
    field: string,
    value: number | undefined,
): void {
    if (value !== undefined) output[field] = value
}

function standardQuest(
    tableName: QuestTableName,
    row: QuestRow,
    layout: StandardLayout,
): Record<string, unknown> {
    const fields = row.fields
    requireColumns(tableName, fields, layout.minimumColumns)
    const story = layout.storyCheck !== undefined && isMissing(fields[layout.storyCheck])
    const output: Record<string, unknown> = {
        name: fields[QUEST_DERIVATION_LAYOUTS[tableName].name],
    }
    const clearRewardIndex = story
        ? layout.storyClearReward ?? layout.clearReward
        : layout.clearReward
    if (clearRewardIndex !== undefined) {
        addOptional(
            output,
            "clearRewardId",
            optionalInteger(tableName, fields[clearRewardIndex], "clearRewardId"),
        )
    } else if (layout.hardcodeClearReward !== false) {
        output.clearRewardId = 1
    }
    if (story) return output

    if (layout.enemyLevel !== undefined) {
        addOptional(
            output,
            "enemyLevel",
            optionalInteger(tableName, fields[layout.enemyLevel], "enemyLevel"),
        )
    }

    if (layout.scoreGroup !== undefined) {
        const scoreRewardGroupId = optionalInteger(
            tableName,
            fields[layout.scoreGroup],
            "scoreRewardGroupId",
        )
        addOptional(output, "scoreRewardGroupId", scoreRewardGroupId)
        if (scoreRewardGroupId !== undefined && layout.commonRewardCount !== undefined) {
            if (typeof layout.commonRewardCount === "number") {
                output.commonRewardCount = parseNonNegativeInteger(
                    tableName,
                    fields[layout.commonRewardCount],
                    "commonRewardCount",
                )
            } else {
                output.commonRewardCounts = layout.commonRewardCount.map((column, rank) => (
                    parseNonNegativeInteger(
                        tableName,
                        fields[column],
                        `commonRewardCounts[${rank}]`,
                    )
                ))
            }
        }
    }
    const rankFields = ["bRankTime", "aRankTime", "sRankTime", "sPlusRankTime"] as const
    if (layout.rankTimes === "zero") {
        for (const field of rankFields) output[field] = 0
    } else {
        const rankTimes = layout.rankTimes
        rankFields.forEach((field, index) => {
            output[field] = parseMilliseconds(tableName, fields[rankTimes[index]], field)
        })
    }
    const rewardFields = [
        "rankPointReward",
        "characterExpReward",
        "manaReward",
        "poolExpReward",
    ] as const
    rewardFields.forEach((field, index) => {
        output[field] = optionalInteger(
            tableName,
            fields[layout.rewards[index]],
            field,
        ) ?? 0
    })
    if (layout.element !== undefined) {
        addOptional(output, "element", optionalInteger(tableName, fields[layout.element], "element"))
    }
    if (layout.fixedParty !== undefined) {
        addOptional(
            output,
            "fixedParty",
            optionalInteger(tableName, fields[layout.fixedParty], "fixedParty"),
        )
    }
    if (layout.isBothBoss !== undefined
        && parseBoolean(tableName, fields[layout.isBothBoss], "isBothBoss")) {
        output.isBothBoss = true
    }
    if (layout.sPlusReward !== undefined) {
        addOptional(
            output,
            "sPlusRewardId",
            optionalInteger(tableName, fields[layout.sPlusReward], "sPlusRewardId"),
        )
    }

    if (tableName === "expert_single_event_quest.json") {
        output.eventId = parseInteger(tableName, row.path[0], "eventId")
    } else if (tableName === "raid_event_quest.json") {
        output.eventId = parseInteger(tableName, row.path[0], "eventId")
        output.folderId = parseInteger(tableName, fields[2], "folderId")
        output.killCountWeight = parseInteger(tableName, fields[52], "killCountWeight")
    }
    return output
}

function specialQuest(tableName: QuestTableName, row: QuestRow): Record<string, unknown> {
    const fields = row.fields
    if (tableName === "character_quest.json") {
        requireColumns(tableName, fields, 6)
        return {
            name: fields[QUEST_DERIVATION_LAYOUTS[tableName].name],
            clearRewardId: parseInteger(tableName, fields[5], "clearRewardId"),
        }
    }
    if (tableName === "ranking_event_single_quest.json") {
        requireColumns(tableName, fields, 69)
        const output: Record<string, unknown> = {
            name: fields[QUEST_DERIVATION_LAYOUTS[tableName].name],
            bRankTime: 0,
            aRankTime: 0,
            sRankTime: 0,
            sPlusRankTime: 0,
            rankPointReward: 0,
            characterExpReward: 0,
            manaReward: 0,
            poolExpReward: 0,
            element: parseInteger(tableName, fields[68], "element"),
        }
        addOptional(output, "enemyLevel", optionalInteger(tableName, fields[89], "enemyLevel"))
        addOptional(output, "clearRewardId", optionalInteger(tableName, fields[4], "clearRewardId"))
        return output
    }
    if (tableName === "hard_multi_event_quest.json") {
        requireColumns(tableName, fields, 98)
        const output: Record<string, unknown> = {
            name: fields[2],
            bRankTime: parseMilliseconds(tableName, fields[85], "bRankTime"),
            aRankTime: parseMilliseconds(tableName, fields[86], "aRankTime"),
            sRankTime: parseMilliseconds(tableName, fields[87], "sRankTime"),
            sPlusRankTime: parseMilliseconds(tableName, fields[88], "sPlusRankTime"),
            rankPointReward: optionalInteger(tableName, fields[94], "rankPointReward") ?? 0,
            characterExpReward: optionalInteger(tableName, fields[95], "characterExpReward") ?? 0,
            manaReward: optionalInteger(tableName, fields[96], "manaReward") ?? 0,
            poolExpReward: optionalInteger(tableName, fields[97], "poolExpReward") ?? 0,
            element: parseInteger(tableName, fields[73], "element"),
        }
        addOptional(output, "enemyLevel", optionalInteger(tableName, fields[107], "enemyLevel"))
        addOptional(output, "clearRewardId", optionalInteger(tableName, fields[4], "clearRewardId"))
        addOptional(output, "sPlusRewardId", optionalInteger(tableName, fields[72], "sPlusRewardId"))
        addOptional(
            output,
            "scoreRewardGroupId",
            optionalInteger(tableName, fields[71], "scoreRewardGroupId"),
        )
        if (output.scoreRewardGroupId !== undefined) {
            output.commonRewardCounts = [89, 90, 91, 92, 93].map((column, rank) => (
                parseNonNegativeInteger(tableName, fields[column], `commonRewardCounts[${rank}]`)
            ))
        }
        return output
    }
    if (tableName === "rush_event_quest.json") {
        requireColumns(tableName, fields, 86)
        const output: Record<string, unknown> = {
            name: fields[QUEST_DERIVATION_LAYOUTS[tableName].name],
            bRankTime: 0,
            aRankTime: 0,
            sRankTime: 0,
            sPlusRankTime: 0,
            rankPointReward: parseInteger(tableName, fields[82], "rankPointReward"),
            characterExpReward: parseInteger(tableName, fields[83], "characterExpReward"),
            manaReward: parseInteger(tableName, fields[84], "manaReward"),
            poolExpReward: parseInteger(tableName, fields[85], "poolExpReward"),
            rushEventId: parseInteger(tableName, row.path[0], "rushEventId"),
            rushEventFolderId: parseInteger(tableName, fields[1], "rushEventFolderId"),
            rushEventRound: parseInteger(tableName, fields[2], "rushEventRound"),
        }
        addOptional(output, "enemyLevel", optionalInteger(tableName, fields[95], "enemyLevel"))
        addOptional(output, "clearRewardId", optionalInteger(tableName, fields[6], "clearRewardId"))
        addOptional(
            output,
            "scoreRewardGroupId",
            optionalInteger(tableName, fields[68], "scoreRewardGroupId"),
        )
        if (output.scoreRewardGroupId !== undefined) {
            output.commonRewardCount = parseNonNegativeInteger(
                tableName, fields[81], "commonRewardCount",
            )
        }
        addOptional(output, "element", optionalInteger(tableName, fields[69], "element"))
        return output
    }
    if (tableName === "carnival_event_quest.json") {
        requireColumns(tableName, fields, 105)
        const output: Record<string, unknown> = {
            name: fields[QUEST_DERIVATION_LAYOUTS[tableName].name],
            bRankTime: 0,
            aRankTime: 0,
            sRankTime: 0,
            sPlusRankTime: 0,
            rankPointReward: optionalInteger(tableName, fields[82], "rankPointReward") ?? 0,
            characterExpReward: optionalInteger(tableName, fields[83], "characterExpReward") ?? 0,
            manaReward: optionalInteger(tableName, fields[84], "manaReward") ?? 0,
            poolExpReward: optionalInteger(tableName, fields[85], "poolExpReward") ?? 0,
            element: parseInteger(tableName, fields[69], "element"),
            eventId: parseInteger(tableName, row.path[0], "eventId"),
            folderId: parseInteger(tableName, fields[1], "folderId"),
            timeLimitMs: Math.round(parseInteger(tableName, fields[100], "timeLimit") * 1000 / 60),
            difficultyScore: parseNumericInteger(tableName, fields[104], "difficultyScore"),
        }
        addOptional(output, "enemyLevel", optionalInteger(tableName, fields[95], "enemyLevel"))
        addOptional(output, "clearRewardId", optionalInteger(tableName, fields[6], "clearRewardId"))
        addOptional(
            output,
            "scoreRewardGroupId",
            optionalInteger(tableName, fields[68], "scoreRewardGroupId"),
        )
        if (output.scoreRewardGroupId !== undefined) {
            output.commonRewardCount = parseNonNegativeInteger(
                tableName, fields[81], "commonRewardCount",
            )
        }
        return output
    }
    if (tableName === "score_attack_event_quest.json") {
        requireColumns(tableName, fields, 105)
        const output: Record<string, unknown> = {
            name: fields[4],
            eventId: parseInteger(tableName, row.path[0], "eventId"),
            scoreAttackQuestId: parseInteger(tableName, row.path[1], "scoreAttackQuestId"),
            bRankScore: parseNumericInteger(tableName, fields[52], "bRankScore"),
            aRankScore: parseNumericInteger(tableName, fields[53], "aRankScore"),
            sRankScore: parseNumericInteger(tableName, fields[54], "sRankScore"),
            ssRankScore: parseNumericInteger(tableName, fields[55], "ssRankScore"),
            rankPointReward: parseNumericInteger(tableName, fields[86], "rankPointReward"),
            characterExpReward: parseNumericInteger(tableName, fields[87], "characterExpReward"),
            manaReward: parseNumericInteger(tableName, fields[88], "manaReward"),
            poolExpReward: parseNumericInteger(tableName, fields[89], "poolExpReward"),
            element: parseInteger(tableName, fields[73], "element"),
            timeLimitMs: Math.round(parseInteger(tableName, fields[104], "timeLimit") * 1000 / 60),
        }
        addOptional(output, "enemyLevel", optionalInteger(tableName, fields[99], "enemyLevel"))
        addOptional(output, "folderId", optionalInteger(tableName, fields[1], "folderId"))
        addOptional(output, "clearRewardId", optionalInteger(tableName, fields[6], "clearRewardId"))
        addOptional(
            output,
            "scoreRewardGroupId",
            optionalInteger(tableName, fields[72], "scoreRewardGroupId"),
        )
        if (output.scoreRewardGroupId !== undefined) {
            output.commonRewardCount = parseNonNegativeInteger(
                tableName, fields[85], "commonRewardCount",
            )
        }
        return output
    }
    return invalidQuest(tableName, "converter is not configured")
}

export function convertQuestTree(
    tableName: QuestTableName,
    tree: CsvOrderedMapTree,
): Readonly<Record<string, unknown>> {
    const source = QUEST_TABLE_SOURCES[tableName]
    if (!source) return invalidQuest(tableName, "table is not registered")
    const layout = STANDARD_LAYOUTS[tableName]
    const output: Record<string, unknown> = {}
    for (const row of collectRows(tableName, tree, source.nestingDepth)) {
        requireColumns(tableName, row.fields, 1)
        const questId = tableName === "character_quest.json"
            ? row.path[0]
            : row.fields[0]
        if (!/^[1-9]\d*$/.test(questId)) invalidQuest(tableName, `invalid quest id: ${questId}`)
        if (output[questId] !== undefined) invalidQuest(tableName, `duplicate quest id: ${questId}`)
        output[questId] = layout
            ? standardQuest(tableName, row, layout)
            : specialQuest(tableName, row)
    }
    return deepFreeze(output)
}

function questIdForRow(tableName: QuestTableName, row: QuestRow): string {
    return tableName === "character_quest.json" ? row.path[0] : row.fields[0]
}

export function buildQuestEntryCosts(
    trees: Readonly<Partial<Record<QuestTableName, CsvOrderedMapTree>>>,
): Readonly<Record<string, unknown>> {
    const output: Record<string, unknown> = {}
    for (const tableName of Object.keys(QUEST_TABLE_SOURCES) as QuestTableName[]) {
        const tree = trees[tableName]
        if (!tree) continue
        const source = QUEST_TABLE_SOURCES[tableName]
        const layout = QUEST_DERIVATION_LAYOUTS[tableName]
        for (const row of collectRows(tableName, tree, source.nestingDepth)) {
            const questId = questIdForRow(tableName, row)
            const [modeIndex, itemIdIndex, itemCountIndex] = layout.entryItem
            requireColumns(
                tableName,
                row.fields,
                Math.max(layout.stamina, modeIndex, itemIdIndex, itemCountIndex) + 1,
            )
            const stamina = parseNonNegativeInteger(
                tableName,
                row.fields[layout.stamina],
                "battle_stamina_cost",
            )
            const rawMode = row.fields[modeIndex]
            if (!isMissing(rawMode) && rawMode !== "0" && rawMode !== "1") {
                invalidQuest(tableName, `battle_startable_use_item_mode is invalid: ${rawMode}`)
            }
            const usesItem = rawMode === "1"
            const itemId = usesItem
                ? parseNonNegativeInteger(tableName, row.fields[itemIdIndex], "entry_item_id")
                : 0
            const itemCount = usesItem
                ? parseNonNegativeInteger(tableName, row.fields[itemCountIndex], "entry_item_count")
                : 0
            if (usesItem && (itemId === 0 || itemCount === 0)) {
                invalidQuest(tableName, "item entry mode requires a positive item id and count")
            }
            if (stamina === 0 && !usesItem) continue
            const key = `${layout.category}_${questId}`
            if (output[key] !== undefined) invalidQuest(tableName, `duplicate entry cost: ${key}`)
            output[key] = { itemId, itemCount, stamina }
        }
    }
    return deepFreeze(output)
}

export function buildQuestUnlockCosts(
    trees: Readonly<Partial<Record<QuestTableName, CsvOrderedMapTree>>>,
): Readonly<Record<string, unknown>> {
    const output: Record<string, unknown> = {}
    for (const tableName of Object.keys(QUEST_TABLE_SOURCES) as QuestTableName[]) {
        const tree = trees[tableName]
        if (!tree) continue
        const source = QUEST_TABLE_SOURCES[tableName]
        const layout = QUEST_DERIVATION_LAYOUTS[tableName]
        for (const row of collectRows(tableName, tree, source.nestingDepth)) {
            const [modeIndex, itemIdIndex, itemCountIndex] = layout.entryItem
            requireColumns(
                tableName,
                row.fields,
                Math.max(modeIndex, itemIdIndex, itemCountIndex) + 1,
            )
            if (row.fields[modeIndex] !== "0") continue
            const itemIds = parseIntegerList(
                tableName,
                row.fields[itemIdIndex],
                "unlock_item_ids",
            )
            const itemCounts = parseIntegerList(
                tableName,
                row.fields[itemCountIndex],
                "unlock_item_counts",
            )
            if (itemIds.length === 0 || itemIds.length !== itemCounts.length) {
                invalidQuest(tableName, "unlock item ids and counts must have the same non-zero length")
            }
            const questId = questIdForRow(tableName, row)
            if (output[questId] !== undefined) {
                invalidQuest(tableName, `duplicate unlock cost: ${questId}`)
            }
            output[questId] = { itemIds, itemCounts }
        }
    }
    return deepFreeze(output)
}

export function buildQuestLookup(
    tables: Readonly<Partial<Record<QuestTableName, Readonly<Record<string, unknown>>>>>,
    practiceTree: CsvOrderedMapTree,
    compatibilityPracticeQuests: Readonly<Record<string, { readonly name?: unknown }>> = {},
): Readonly<Record<string, unknown>> {
    const output: Record<string, unknown> = {}
    for (const tableName of Object.keys(QUEST_TABLE_SOURCES) as QuestTableName[]) {
        const table = tables[tableName]
        if (!table) continue
        const category = QUEST_DERIVATION_LAYOUTS[tableName].category
        for (const [questId, value] of Object.entries(table)) {
            if (!value || typeof value !== "object") invalidQuest(tableName, `invalid quest ${questId}`)
            const name = (value as Record<string, unknown>).name
            if (typeof name !== "string") invalidQuest(tableName, `quest ${questId} has no name`)
            output[`${category}_${questId}`] = name
        }
    }
    for (const row of collectRows("practice_quest.json", practiceTree, 1)) {
        requireColumns("practice_quest.json", row.fields, 3)
        output[`15_${row.path[0]}`] = row.fields[2]
    }
    for (const [questId, quest] of Object.entries(compatibilityPracticeQuests)) {
        if (!/^[1-9]\d*$/.test(questId)
            || !Number.isSafeInteger(Number(questId))
            || typeof quest?.name !== "string") continue
        const key = `15_${questId}`
        if (output[key] !== undefined) continue
        output[key] = quest.name
    }
    return deepFreeze(output)
}

export function buildDailyChallengePointLookup(
    tree: CsvOrderedMapTree,
): Readonly<Record<string, unknown>> {
    const output: Record<string, unknown> = {}
    for (const row of collectRows("daily_challenge_point_lookup.json", tree, 1)) {
        requireColumns("daily_challenge_point_lookup.json", row.fields, 5)
        output[row.path[0]] = {
            maxPoint: parseNonNegativeInteger(
                "daily_challenge_point_lookup.json",
                row.fields[1],
                "max_challenge_point",
            ),
            isRecovery: parseBoolean(
                "daily_challenge_point_lookup.json",
                row.fields[3],
                "is_recovery",
            ),
            name: row.fields[4],
        }
    }
    return deepFreeze(output)
}

export function buildEventChallengePointMap(
    expertTree: CsvOrderedMapTree,
    soloTree: CsvOrderedMapTree,
): Readonly<Record<string, unknown>> {
    const output: Record<string, unknown> = {}
    for (const row of collectRows("expert_single_event.json", expertTree, 1)) {
        requireColumns("expert_single_event.json", row.fields, 11)
        output[`expert_${row.path[0]}`] = parseInteger(
            "expert_single_event.json",
            row.fields[10],
            "daily_challenge_point_id",
        )
    }
    for (const row of collectRows("solo_time_attack_event.json", soloTree, 1)) {
        requireColumns("solo_time_attack_event.json", row.fields, 10)
        output[`solo_${row.path[0]}`] = parseInteger(
            "solo_time_attack_event.json",
            row.fields[9],
            "daily_challenge_point_id",
        )
    }
    return deepFreeze(output)
}

export async function convertQuests(
    reader: QuestSourceReader,
    compatibility: QuestConversionCompatibility,
): Promise<QuestConversionOutput> {
    const convertedSources = await Promise.all(
        (Object.entries(QUEST_TABLE_SOURCES) as Array<[
            QuestTableName,
            (typeof QUEST_TABLE_SOURCES)[QuestTableName],
        ]>).map(async ([tableName, source]) => {
            const raw = await reader.readDynamic(source.logicalPath)
            const tree = convertOrderedMapJson(raw, source.nestingDepth)
            return [tableName, tree, convertQuestTree(tableName, tree)] as const
        }),
    )
    const questTables = Object.fromEntries(convertedSources.map(
        ([tableName, _tree, table]) => [tableName, table],
    )) as Record<
        QuestTableName,
        Readonly<Record<string, unknown>>
    >
    const questTrees = Object.fromEntries(convertedSources.map(
        ([tableName, tree]) => [tableName, tree],
    )) as Record<QuestTableName, CsvOrderedMapTree>
    const [dailyChallengePoint, expertSingleEvent, soloTimeAttackEvent, practiceQuest] = await Promise.all([
        reader.readDynamic(QUEST_AUXILIARY_SOURCES.dailyChallengePoint),
        reader.readDynamic(QUEST_AUXILIARY_SOURCES.expertSingleEvent),
        reader.readDynamic(QUEST_AUXILIARY_SOURCES.soloTimeAttackEvent),
        reader.readDynamic(QUEST_AUXILIARY_SOURCES.practiceQuest),
    ])
    return deepFreeze({
        ...questTables,
        "daily_challenge_point_lookup.json": buildDailyChallengePointLookup(
            convertOrderedMapJson(dailyChallengePoint, 1),
        ),
        "event_challenge_point_map.json": buildEventChallengePointMap(
            convertOrderedMapJson(expertSingleEvent, 1),
            convertOrderedMapJson(soloTimeAttackEvent, 1),
        ),
        "quest_entry_costs.json": buildQuestEntryCosts(questTrees),
        "quest_lookup.json": buildQuestLookup(
            questTables,
            convertOrderedMapJson(practiceQuest, 1),
            compatibility.practiceQuests,
        ),
        "quest_unlock_costs.json": buildQuestUnlockCosts(questTrees),
    })
}
