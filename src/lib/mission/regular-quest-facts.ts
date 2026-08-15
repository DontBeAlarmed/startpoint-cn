import bundledExQuests from "../../../assets/ex_quest.json"
import bundledMainQuests from "../../../assets/main_quest.json"
import { getRuntimeContentTableSync } from "../../content/runtime/table-access"
import {
    getMissionMasterDefinition,
    type MissionMasterDefinition,
} from "./master-data"
import type { CategoryContext } from "./types"

type RawQuestTable = Record<string, unknown>

function parseIntegerList(value: unknown): readonly number[] | null {
    if (value === undefined || value === null || value === "(None)") return null
    if (value === "") return []
    const values = String(value).split(",").map(Number)
    return values.every(Number.isSafeInteger) ? values : null
}

function getFinishedQuestIds(
    ctx: CategoryContext,
    section: number,
): ReadonlySet<number> {
    return new Set(
        (ctx.questProgress[String(section)] ?? [])
            .filter(progress => progress.finished)
            .map(progress => progress.questId),
    )
}

function matchesSelector(
    questId: number,
    worlds: readonly number[] | null,
    chapters: readonly number[] | null,
    quests: readonly number[] | null,
): boolean {
    const world = Math.floor(questId / 1_000_000)
    const chapter = Math.floor(questId / 1_000) % 1_000
    const quest = questId % 1_000
    return (worlds === null || worlds.includes(world))
        && (chapters === null || chapters.includes(chapter))
        && (quests === null || quests.includes(quest))
}

function getStoryQuestRule(definition: MissionMasterDefinition): {
    readonly section: number
    readonly candidates: readonly number[]
} | null {
    const rangeKind = Number(definition.row[7])
    if (rangeKind !== 0 && rangeKind !== 1) return null
    const worlds = parseIntegerList(definition.row[8])
    const chapters = parseIntegerList(definition.row[9])
    const quests = parseIntegerList(definition.row[10])
    if (worlds === null && chapters === null && quests === null) return null

    const table = rangeKind === 0
        ? getRuntimeContentTableSync<RawQuestTable>("main_quest.json", bundledMainQuests)
        : getRuntimeContentTableSync<RawQuestTable>("ex_quest.json", bundledExQuests)
    const candidates = Object.keys(table)
        .map(Number)
        .filter(questId => Number.isSafeInteger(questId)
            && matchesSelector(questId, worlds, chapters, quests))
    return candidates.length > 0
        ? { section: rangeKind === 0 ? 1 : 4, candidates }
        : null
}

function getPracticeQuestCandidates(
    definition: MissionMasterDefinition,
): readonly number[] | null {
    if (Number(definition.row[7]) !== 11) return null
    const candidates = parseIntegerList(definition.row[10])
    return candidates && candidates.length > 0 ? candidates : null
}

function computeStoryQuestRange(
    missionId: number,
    ctx: CategoryContext,
): number | undefined {
    const definition = getMissionMasterDefinition(1, missionId)
    const rule = definition ? getStoryQuestRule(definition) : null
    if (!rule) return undefined
    const finished = getFinishedQuestIds(ctx, rule.section)
    return rule.candidates.every(questId => finished.has(questId)) ? 1 : 0
}

function computePracticeQuestRange(
    missionId: number,
    ctx: CategoryContext,
): number | undefined {
    const definition = getMissionMasterDefinition(1, missionId)
    const candidates = definition ? getPracticeQuestCandidates(definition) : null
    if (!candidates) return undefined
    const finished = getFinishedQuestIds(ctx, 15)
    return candidates.some(questId => finished.has(questId)) ? 1 : 0
}

export function isRegularQuestMissionSupported(missionId: number): boolean {
    const definition = getMissionMasterDefinition(1, missionId)
    return definition !== undefined && getRegularQuestFactSection(definition) !== undefined
}

export function getRegularQuestFactSection(
    definition: MissionMasterDefinition,
): number | undefined {
    const storyRule = getStoryQuestRule(definition)
    if (storyRule) return storyRule.section
    return getPracticeQuestCandidates(definition) ? 15 : undefined
}

export function computeRegularQuestProgress(
    missionId: number,
    ctx: CategoryContext,
): number | undefined {
    return computeStoryQuestRange(missionId, ctx)
        ?? computePracticeQuestRange(missionId, ctx)
}
