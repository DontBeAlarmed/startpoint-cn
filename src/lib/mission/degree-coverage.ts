import { getDegreeClientProgressPattern } from "./client-progress"
import {
    buildDegreeRuleCatalog,
    resolveBossBattleSuperQuestId,
} from "./degree-rule-catalog"
import { DEGREE_SUPPORTED_FAMILIES as FAMILY } from "./degree-context-requirements"
import {
    getMissionCatalog,
    getMissionCatalogContentTable,
    type MissionCatalog,
} from "./mission-catalog"
import {
    getDegreeMvpMissionIds,
    getExactDegreeQuestClearRuleCount,
} from "./degree-battle-facts"
import { getDegreeOperationRuleCount } from "./degree-operation-facts"

export function getTargetDegree(missionId: number): number | undefined {
    const catalog = getMissionCatalog()
    return buildDegreeRuleCatalog(catalog, [missionId]).rules.get(missionId)?.target
}

export function getBossBattleSuperQuestId(
    missionId: number,
    bossBattleQuests?: Record<string, unknown>,
): number | undefined {
    const catalog = getMissionCatalog()
    const definition = catalog.getDefinition(5, missionId)
    if (!definition) return undefined
    let table = bossBattleQuests
    if (table === undefined) {
        try {
            table = getMissionCatalogContentTable(catalog, "boss_battle_quest.json")
        } catch {
            return undefined
        }
    }
    return resolveBossBattleSuperQuestId(definition, table)
}

export function getDegreeComputedMissionIds(
    catalog: MissionCatalog = getMissionCatalog(),
): readonly number[] {
    const rules = buildDegreeRuleCatalog(catalog).rules
    return Object.freeze([...rules.values()]
        .filter(rule => rule.kind !== "unsupported")
        .map(rule => rule.missionId)
        .sort((left, right) => left - right))
}

export function getDegreeMissionCoverageReport() {
    const catalog = getMissionCatalog()
    const definitions = catalog.getDefinitions(5)
    const rules = [...buildDegreeRuleCatalog(catalog).rules.values()]
    const countPattern = (prefix: string) => definitions.filter(definition => (
        definition.pattern.startsWith(prefix)
    )).length
    const countKind = (kind: string) => rules.filter(rule => rule.kind === kind).length
    const countFinished = (section: number, prefix: string) => rules.filter(rule => (
        rule.kind === "finishedQuest" && rule.section === section && rule.pattern.startsWith(prefix)
    )).length
    const prefixFamilies = Object.fromEntries(Object.entries(FAMILY).map(([name, prefix]) => (
        [name, countPattern(prefix)]
    )))
    const supportedFamilies = {
        ...prefixFamilies,
        characterLevel: countKind("maxCharacterLevel"),
        specificCharacterBond: countKind("specificCharacterBond"),
        secondManaBoardNodeCount: countKind("secondManaBoardAggregate"),
        secondManaBoardCompletion: countKind("secondManaBoardCharacter"),
        episodeChapterCompletion: countKind("episodeChapter"),
        practiceRankSs: countKind("practiceSs"),
        treasureShopPurchaseCount: countKind("treasureShopPurchases"),
        bossBattleExClearSingle: countFinished(2, "degree_boss_battle_ex_clear_single_"),
        expertSingleQuestClear: countFinished(21, ""),
        worldStoryQuestClear: countFinished(18, ""),
        adventQuestClear: countFinished(7, ""),
        carnivalQuestClear: countFinished(22, ""),
        hardMultiQuestClear: countFinished(26, ""),
        specifiedQuestClearCount: getExactDegreeQuestClearRuleCount(),
        mvpFacts: getDegreeMvpMissionIds().length,
        operationFacts: getDegreeOperationRuleCount(),
        eventCollectItem: countKind("collectedItem"),
        maxLevelEquipment: countKind("maxLevelEquipment"),
        clientProgress: definitions.filter(definition => (
            getDegreeClientProgressPattern(definition) !== undefined
        )).length,
    }
    const serverComputed = rules.filter(rule => rule.kind !== "unsupported").length
    return {
        total: definitions.length,
        serverComputed,
        unsupported: definitions.length - serverComputed,
        supportedFamilies,
    }
}
