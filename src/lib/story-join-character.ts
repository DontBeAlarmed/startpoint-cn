import bundledStoryJoinCharacters from "../../assets/story_join_character.json"

import { getPlayerCharacterSync } from "../data/domains/character"
import { getPlayerSingleQuestProgressSync } from "../data/domains/quest"
import { getRuntimeContentTableSync } from "../content/runtime/table-access"
import { QuestCategory } from "./types"

type RawStoryJoinCharacterTable = Record<string, unknown>

export type StoryJoinType = "quest" | "town"

export interface StoryJoinCharacterDefinition {
    readonly characterId: number
    readonly category: QuestCategory
    readonly questId: number
    readonly priority: number
    readonly joinType: StoryJoinType
    readonly temporary: boolean
}

const CATEGORY_BY_REFERENCE_KIND: Readonly<Record<number, QuestCategory>> = Object.freeze({
    0: QuestCategory.MAIN,
    1: QuestCategory.EX,
    2: QuestCategory.BOSS_BATTLE,
    3: QuestCategory.DAILY_WEEK_EVENT,
    4: QuestCategory.RANKING_EVENT_SINGLE,
    5: QuestCategory.STORY_EVENT_SINGLE,
    6: QuestCategory.ADVENT_EVENT_MULTI,
    7: QuestCategory.CHALLENGE_DUNGEON_EVENT,
    8: QuestCategory.DAILY_EXP_MANA_EVENT,
    9: QuestCategory.WORLD_STORY_EVENT,
    10: QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE,
    11: QuestCategory.TOWER_DUNGEON_EVENT,
    12: QuestCategory.EXPERT_SINGLE_EVENT,
    13: QuestCategory.CARNIVAL_EVENT,
    14: QuestCategory.CHARACTER,
    15: QuestCategory.RAID_EVENT,
    16: QuestCategory.RUSH_EVENT,
    17: QuestCategory.SOLO_TIME_ATTACK_EVENT,
    18: QuestCategory.HARD_MULTI_EVENT,
    19: QuestCategory.SCORE_ATTACK_EVENT,
})

function parseInteger(value: unknown, field: string): number {
    if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
        throw new Error(`story_join_character ${field} must be an integer string`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`story_join_character ${field} is outside the safe integer range`)
    }
    return parsed
}

function resolveQuestId(referenceKind: number, row: readonly unknown[]): number {
    const first = parseInteger(row[1], "condition[0]")
    const second = parseInteger(row[2], "condition[1]")
    const third = parseInteger(row[3], "condition[2]")
    if (referenceKind <= 2) return first * 1_000_000 + second * 1_000 + third
    if (referenceKind === 14) return third
    return first * 1_000 + third
}

export function parseStoryJoinCharacterTable(
    table: RawStoryJoinCharacterTable,
): readonly StoryJoinCharacterDefinition[] {
    if (!table || typeof table !== "object" || Array.isArray(table)) {
        throw new Error("story_join_character table must be an object")
    }

    const definitions: StoryJoinCharacterDefinition[] = []
    for (const [characterIdText, rawRows] of Object.entries(table)) {
        const characterId = Number(characterIdText)
        if (!Number.isSafeInteger(characterId) || characterId <= 0
            || !Array.isArray(rawRows) || rawRows.length !== 1
            || !Array.isArray(rawRows[0]) || rawRows[0].length !== 8) {
            throw new Error(`story_join_character row ${characterIdText} is malformed`)
        }
        const row = rawRows[0]
        const referenceKind = parseInteger(row[0], "reference kind")
        const category = CATEGORY_BY_REFERENCE_KIND[referenceKind]
        if (category === undefined) {
            throw new Error(`story_join_character row ${characterIdText} has an unknown reference kind`)
        }
        const questId = resolveQuestId(referenceKind, row)
        const multipliedId = parseInteger(row[4], "multiplied id")
        if (questId !== multipliedId || questId <= 0) {
            throw new Error(`story_join_character row ${characterIdText} has inconsistent quest ids`)
        }
        const joinType = row[6]
        if (joinType !== "quest" && joinType !== "town") {
            throw new Error(`story_join_character row ${characterIdText} has an unknown join type`)
        }
        if (row[7] !== "true" && row[7] !== "false") {
            throw new Error(`story_join_character row ${characterIdText} has an invalid temporary flag`)
        }
        definitions.push(Object.freeze({
            characterId,
            category,
            questId,
            priority: parseInteger(row[5], "priority"),
            joinType,
            temporary: row[7] === "true",
        }))
    }
    return Object.freeze(definitions)
}

function getDefinitions(): readonly StoryJoinCharacterDefinition[] {
    return parseStoryJoinCharacterTable(getRuntimeContentTableSync(
        "story_join_character.json",
        bundledStoryJoinCharacters as RawStoryJoinCharacterTable,
    ))
}

export function getQuestJoinCharacterIds(
    category: number,
    questId: number,
): number[] {
    return getDefinitions()
        .filter(definition => definition.joinType === "quest"
            && definition.category === category
            && definition.questId === questId)
        .map(definition => definition.characterId)
}

export function canClaimTownStoryCharacter(
    playerId: number,
    characterId: number,
): boolean {
    if (getPlayerCharacterSync(playerId, characterId) !== null) return false
    const definition = getDefinitions().find(entry => (
        entry.characterId === characterId && entry.joinType === "town"
    ))
    if (!definition) return false
    return getPlayerSingleQuestProgressSync(
        playerId,
        definition.category,
        definition.questId,
    )?.finished === true
}
