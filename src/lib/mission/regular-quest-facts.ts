import type { CategoryContext, RegularQuestRule } from "./types"
import {
    type MissionCatalog,
    type MissionMasterDefinition,
    getMissionCatalog,
    getMissionCatalogContentTable,
} from "./mission-catalog"

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

function getStoryQuestRule(
    definition: MissionMasterDefinition,
    catalog: MissionCatalog,
): RegularQuestRule | null {
    const rangeKind = Number(definition.row[7])
    if (rangeKind !== 0 && rangeKind !== 1) return null
    const worlds = parseIntegerList(definition.row[8])
    const chapters = parseIntegerList(definition.row[9])
    const quests = parseIntegerList(definition.row[10])
    if (worlds === null && chapters === null && quests === null) return null

    const table = getMissionCatalogContentTable<RawQuestTable>(
        catalog,
        rangeKind === 0 ? "main_quest.json" : "ex_quest.json",
    )
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

export function getRegularQuestRule(
    definition: MissionMasterDefinition,
    catalog: MissionCatalog,
): RegularQuestRule | undefined {
    return getRegularQuestRules(catalog).get(definition.missionId)
}

const regularQuestRulesByCatalog = new WeakMap<MissionCatalog, ReadonlyMap<number, RegularQuestRule>>()

function getRegularQuestRules(catalog: MissionCatalog): ReadonlyMap<number, RegularQuestRule> {
    const cached = regularQuestRulesByCatalog.get(catalog)
    if (cached) return cached
    const rules = new Map<number, RegularQuestRule>()
    for (const definition of catalog.getDefinitions(1)) {
        const storyRule = getStoryQuestRule(definition, catalog)
        const practiceCandidates = storyRule ? null : getPracticeQuestCandidates(definition)
        const rule = storyRule
            ?? (practiceCandidates ? { section: 15, candidates: practiceCandidates } : undefined)
        if (rule) rules.set(definition.missionId, Object.freeze({
            section: rule.section,
            candidates: Object.freeze([...rule.candidates]),
        }))
    }
    regularQuestRulesByCatalog.set(catalog, rules)
    return rules
}

export function isRegularQuestMissionSupported(
    missionId: number,
    catalog: MissionCatalog = getMissionCatalog(),
): boolean {
    const definition = catalog.getDefinition(1, missionId)
    return definition !== undefined && getRegularQuestRule(definition, catalog) !== undefined
}

export function getRegularQuestFactSection(
    definition: MissionMasterDefinition,
    catalog: MissionCatalog = getMissionCatalog(),
): number | undefined {
    return getRegularQuestRule(definition, catalog)?.section
}

export function computeRegularQuestProgress(
    missionId: number,
    ctx: CategoryContext,
): number | undefined {
    const rule = ctx.regularQuestRules?.get(missionId)
    if (!rule) return undefined
    const finished = getFinishedQuestIds(ctx, rule.section)
    return rule.section === 15
        ? (rule.candidates.some(questId => finished.has(questId)) ? 1 : 0)
        : (rule.candidates.every(questId => finished.has(questId)) ? 1 : 0)
}
