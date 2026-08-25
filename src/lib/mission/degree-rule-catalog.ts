import { buildFactLoadPlan } from "./facts/load-plan"
import type { FactKey } from "./facts/fact-key"
import type { MissionCatalog, MissionMasterDefinition } from "./mission-catalog"
import { parsePositiveSafeIntegerMasterValue } from "./master-value"
import { getDegreeRequirement } from "./requirements/provider-degree"
import {
    asDegreeTable,
    loadDegreeContentTables,
    resolveBossBattleQuestId,
    type DegreeContentTables,
} from "./degree-content-tables"
import { readonlyMap } from "./degree-immutable"
import {
    DEGREE_SUPPORTED_FAMILIES as FAMILY,
    getEpisodeChapter,
    getSecondManaBoardCharacterId,
    getSpecificCharacterBondId,
    isAuthoritativeCharacterLevelMission,
    isSecondManaBoardAggregateMission,
} from "./degree-context-requirements"

const QUEST_LEVELS = new Map<number, readonly [number, number]>([
    [1, [1, 19]], [2, [20, 39]], [3, [40, 69]], [4, [80, 89]],
    [5, [70, 79]], [6, [90, 99]], [7, [100, 100]],
])
const BUNDLED_SUPER_IDS = new Map([["1:6", 1006003], ["1:20", 1020003]])

export type DegreeMetric =
    | "companionCount" | "overLimitCount" | "manaBoardCount" | "bondTokenCount"
    | "singleSsCount" | "multiClearCount" | "multiHostClearCount" | "episodeClearCount"
    | "staminaUseCount" | "loginCount" | "challengeDungeonClearCount" | "singleScoreMax"
    | "bossBattleClearCount" | "dashUseCount" | "comboMax" | "craftPointObtainedCount"
    | "skillUseCount" | "feverCount" | "feverMs" | "debuffEnemyCount"
    | "clearEnemyBuffCount" | "clearSelfDebuffCount" | "buffPartyCount"
    | "healPartyCount" | "emotionCount" | "enemyKillCount" | "weakPointAttackCount"
    | "powerFlipLv3Count" | "coffinReducedCount" | "damageDealMax"
    | "revivalCoffinMax" | "partyPowerMax" | "skillChainMax"

interface DegreeRuleBase {
    readonly missionId: number
    readonly pattern: string
    readonly facts: readonly FactKey[]
    readonly target?: number
    readonly targetProgress?: number
}

export type DegreeRule = DegreeRuleBase & (
    | { readonly kind: "persisted" | "unsupported" }
    | { readonly kind: "playerRank" | "maxCharacterLevel" | "secondManaBoardAggregate" | "treasureShopPurchases" | "maxLevelEquipment" }
    | { readonly kind: "metric"; readonly metric: DegreeMetric; readonly replace: boolean }
    | { readonly kind: "specificCharacterBond" | "secondManaBoardCharacter"; readonly characterId: number }
    | { readonly kind: "episodeChapter"; readonly chapter: number }
    | { readonly kind: "practiceSs"; readonly questIds: readonly number[] }
    | { readonly kind: "finishedQuest"; readonly section: number; readonly questId: number }
    | { readonly kind: "collectedItem"; readonly itemId: number }
    | { readonly kind: "singleClearTime"; readonly targetMs: number }
)

type WithoutFacts<Rule> = Rule extends unknown ? Omit<Rule, "facts"> : never
type DegreeRuleDraft = WithoutFacts<DegreeRule>

export interface DegreeRuleCatalog {
    readonly rules: ReadonlyMap<number, DegreeRule>
    readonly tables: DegreeContentTables
}

function descriptionTarget(definition: MissionMasterDefinition, pattern: RegExp, scale = 1): number | undefined {
    const match = pattern.exec(String(definition.row[2] ?? ""))
    const parsed = parsePositiveSafeIntegerMasterValue(match?.[1])
    const value = parsed === undefined ? undefined : parsed * scale
    return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function integerList(value: unknown): readonly number[] | undefined {
    if (typeof value !== "string" || value === "" || value === "(None)") return undefined
    const values = value.split(",").map(parsePositiveSafeIntegerMasterValue)
    return values.length > 0 && values.every((item): item is number => item !== undefined)
        ? Object.freeze(values)
        : undefined
}

function exactQuestId(definition: MissionMasterDefinition, missionType: number, range: number, raw: unknown): number | undefined {
    const quests = asDegreeTable(raw)
    if (!quests || parsePositiveSafeIntegerMasterValue(definition.row[3]) !== missionType
        || parsePositiveSafeIntegerMasterValue(definition.row[8]) !== range) return undefined
    const eventId = parsePositiveSafeIntegerMasterValue(definition.row[9])
    const suffix = parsePositiveSafeIntegerMasterValue(definition.row[11])
    if (eventId === undefined || suffix === undefined) return undefined
    const questId = eventId * 1000 + suffix
    return Number.isSafeInteger(questId) && quests[String(questId)] !== undefined
        ? questId
        : undefined
}

export function resolveBossBattleSuperQuestId(definition: MissionMasterDefinition, raw: unknown): number | undefined {
    const quests = asDegreeTable(raw)
    if (!quests || parsePositiveSafeIntegerMasterValue(definition.row[3]) !== 14
        || !definition.pattern.startsWith("degree_boss_battle_ex_clear_single_")) return undefined
    const family = parsePositiveSafeIntegerMasterValue(definition.row[9])
    const group = parsePositiveSafeIntegerMasterValue(definition.row[10])
    const difficulty = parsePositiveSafeIntegerMasterValue(definition.row[12])
    const range = difficulty === undefined ? undefined : QUEST_LEVELS.get(difficulty)
    if (family === undefined || group === undefined || difficulty === undefined || !range) return undefined
    const resolved = resolveBossBattleQuestId(definition, quests, range)
    if (resolved !== undefined) return resolved
    const candidates = Object.entries(quests).filter(([rawId]) => {
        const questId = parsePositiveSafeIntegerMasterValue(rawId)
        return questId !== undefined && Math.floor(questId / 1_000_000) === family
            && Math.floor(questId / 1_000) % 1_000 === group
    })
    const hasLevels = candidates.some(([, row]) => Object.prototype.hasOwnProperty.call(row, "enemyLevel"))
    if (hasLevels) return undefined
    const questId = BUNDLED_SUPER_IDS.get(`${family}:${group}`) ?? family * 1_000_000 + group * 1_000 + difficulty
    return quests[String(questId)] === undefined ? undefined : questId
}

const METRICS: readonly [string, DegreeMetric, boolean][] = [
    [FAMILY.companionCount, "companionCount", true], [FAMILY.overLimitCount, "overLimitCount", true],
    [FAMILY.manaBoardCount, "manaBoardCount", true], [FAMILY.bondTokenCount, "bondTokenCount", true],
    [FAMILY.singleSsCount, "singleSsCount", true], [FAMILY.multiClearCount, "multiClearCount", false],
    [FAMILY.multiHostClearCount, "multiHostClearCount", false], [FAMILY.episodeClearCount, "episodeClearCount", false],
    [FAMILY.staminaUseCount, "staminaUseCount", false], [FAMILY.loginCount, "loginCount", false],
    [FAMILY.challengeDungeonClear, "challengeDungeonClearCount", false], [FAMILY.bossBattleClear, "bossBattleClearCount", false],
    [FAMILY.skillUse, "skillUseCount", false], [FAMILY.feverCount, "feverCount", false],
    [FAMILY.feverTime, "feverMs", false], [FAMILY.debuffEnemy, "debuffEnemyCount", false],
    [FAMILY.clearEnemyBuff, "clearEnemyBuffCount", false], [FAMILY.clearSelfDebuff, "clearSelfDebuffCount", false],
    [FAMILY.buffParty, "buffPartyCount", false], [FAMILY.healParty, "healPartyCount", false],
    [FAMILY.emotionUse, "emotionCount", false], [FAMILY.enemyKill, "enemyKillCount", false],
    [FAMILY.weakPointAttack, "weakPointAttackCount", false], [FAMILY.powerFlipLv3, "powerFlipLv3Count", false],
    [FAMILY.coffinReduced, "coffinReducedCount", false], [FAMILY.damageMax, "damageDealMax", false],
    [FAMILY.revivalCoffinMax, "revivalCoffinMax", false], [FAMILY.partyPowerMax, "partyPowerMax", false],
    [FAMILY.skillChainMax, "skillChainMax", false],
]

function semanticRule(definition: MissionMasterDefinition, catalog: MissionCatalog, tables: DegreeContentTables): DegreeRuleDraft | undefined {
    const base = { missionId: definition.missionId, pattern: definition.pattern }
    const characterTarget = descriptionTarget(definition, /玩家(?:达到|级别达到)\s*(\d+)/)
    if (definition.pattern.startsWith(FAMILY.playerRank)) return { ...base, kind: "playerRank", target: characterTarget }
    if (isAuthoritativeCharacterLevelMission(definition.missionId, definition, catalog)) return { ...base, kind: "maxCharacterLevel" }
    const bondId = getSpecificCharacterBondId(definition.missionId, definition)
    if (bondId !== undefined) return { ...base, kind: "specificCharacterBond", characterId: bondId }
    const boardId = getSecondManaBoardCharacterId(definition.missionId, definition)
    if (boardId !== undefined) return { ...base, kind: "secondManaBoardCharacter", characterId: boardId }
    if (isSecondManaBoardAggregateMission(definition.missionId, definition)) return { ...base, kind: "secondManaBoardAggregate" }
    const chapter = getEpisodeChapter(definition.missionId, definition)
    if (chapter !== undefined) return { ...base, kind: "episodeChapter", chapter }
    const conditionType = parsePositiveSafeIntegerMasterValue(definition.row[3])
    if (conditionType === 26 && definition.pattern.startsWith("degree_practice_rank_ss_clear_")) {
        const questIds = integerList(definition.row[11])
        return questIds ? { ...base, kind: "practiceSs", questIds } : undefined
    }
    if (conditionType === 45 && definition.pattern.startsWith("degree_treasure_shop_buy_count_")) return { ...base, kind: "treasureShopPurchases" }
    const bossId = resolveBossBattleSuperQuestId(definition, tables.bossBattleQuest)
    if (bossId !== undefined) return { ...base, kind: "finishedQuest", section: 2, questId: bossId }
    for (const [section, missionType, range, raw] of [
        [21, 14, 14, tables.expertSingleEventQuest], [18, 14, 9, tables.worldStoryEventQuest],
        [7, 14, 5, tables.adventEventQuest], [22, 23, 15, tables.carnivalEventQuest],
        [26, 23, 19, tables.hardMultiEventQuest],
    ] as const) {
        const questId = exactQuestId(definition, missionType, range, raw)
        if (questId !== undefined) return { ...base, kind: "finishedQuest", section, questId }
    }
    if (conditionType === 37 && definition.pattern.startsWith("degree_collect_item_event_")) {
        const itemId = parsePositiveSafeIntegerMasterValue(definition.row[13])
        return itemId === undefined ? undefined : { ...base, kind: "collectedItem", itemId }
    }
    if (conditionType === 36 && definition.pattern.startsWith("degree_equipment_lv5_get_")) return { ...base, kind: "maxLevelEquipment" }
    if (definition.pattern.startsWith(FAMILY.timeClearSingle)) {
        const targetMs = descriptionTarget(definition, /单人战斗\s*(\d+)\s*秒以内通关/, 1000)
        return targetMs ? { ...base, kind: "singleClearTime", targetMs, target: targetMs } : undefined
    }
    const targetedMetrics: readonly [string, DegreeMetric, RegExp][] = [
        [FAMILY.scoreClearSingle, "singleScoreMax", /单人战斗获得\s*(\d+)\s*以上的分数/],
        [FAMILY.dashUse, "dashUseCount", /使用\s*(\d+)\s*次冲刺/],
        [FAMILY.comboOneTime, "comboMax", /单次战斗中达成\s*(\d+)\s*连击/],
        [FAMILY.craftPointGet, "craftPointObtainedCount", /累计获得\s*(\d+)\s*个锻造石/],
    ]
    for (const [prefix, metric, regex] of targetedMetrics) {
        if (!definition.pattern.startsWith(prefix)) continue
        const target = descriptionTarget(definition, regex)
        return target ? { ...base, kind: "metric", metric, replace: false, target } : undefined
    }
    const metric = METRICS.find(([prefix]) => definition.pattern.startsWith(prefix))
    return metric ? { ...base, kind: "metric", metric: metric[1], replace: metric[2] } : undefined
}

export function buildDegreeRuleCatalog(catalog: MissionCatalog, missionIds: readonly number[] = catalog.getMissionIds(5)): DegreeRuleCatalog {
    const entries = [...new Set(missionIds)].flatMap(missionId => {
        const definition = catalog.getDefinition(5, missionId)
        return definition ? [{ definition, draft: getDegreeRequirement(definition, catalog) }] : []
    })
    const tables = loadDegreeContentTables(
        catalog,
        entries.filter(entry => entry.draft.mode === "computed").map(entry => entry.definition),
    )
    const rules = new Map<number, DegreeRule>()
    for (const { definition, draft } of entries) {
        const missionId = definition.missionId
        const facts = draft.mode === "computed" ? buildFactLoadPlan(draft.facts ?? []).keys : Object.freeze([])
        const targetProgress = catalog.getRewardStage(5, missionId, 1)?.targetProgress
        const base = { missionId, pattern: definition.pattern, facts, targetProgress }
        if (draft.mode !== "computed") {
            rules.set(missionId, Object.freeze({ ...base, kind: draft.mode }))
            continue
        }
        const semantic = semanticRule(definition, catalog, tables)
        rules.set(missionId, Object.freeze(semantic ? { ...semantic, facts, targetProgress } : {
            ...base,
            facts: Object.freeze([]),
            kind: "unsupported",
        }))
    }
    return Object.freeze({ rules: readonlyMap(rules), tables })
}
