require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const bundledMissions = require("../assets/mission_active.json")
const bundledRewards = require("../assets/mission_active_reward.json")
const { getActiveMissionPlan } = require("../src/lib/mission/active-plan")

const UNSUPPORTED_MISSION_IDS = Object.freeze([
    21030,
    25009,
    25010,
    25011,
    25012,
    25013,
    25014,
    25017,
    25018,
    25022,
])

function buildFixture(definitions, resolveQuestIds) {
    const mainChapterQuestIds = Array.from({ length: 6 }, (_, index) => (index + 1) * 1_000_000 + 1_001)
    const exChapterQuestIds = mainChapterQuestIds.map(questId => questId + 10_000_000)
    const chapterProgress = mainChapterQuestIds.flatMap(questId => [
        { category: 1, questId, finished: true, clearRank: 5, multiClearCount: 0 },
        { category: 4, questId, finished: true, clearRank: 5, multiClearCount: 0 },
    ])
    const resolvedQuestIds = definitions
        .filter(definition => Number(definition.row[29]) === 57)
        .flatMap(definition => resolveQuestIds(definition.row))
    const activeMissions = Object.fromEntries(definitions.map(definition => [
        definition.missionId,
        { progress: 1_000_000, stages: {} },
    ]))
    const state = {
        player: { totalLoginDays: 7, totalStaminaUsed: 11 },
        battleCounters: {
            singleClearCount: 13,
            multiClearCount: 17,
            multiHostClearCount: 19,
            singleRankSsCount: 23,
            rankSsCount: 29,
        },
        finishedQuestIds: new Set([...resolvedQuestIds, 700001]),
        questProgress: chapterProgress,
        chapterQuestIds: {
            "1": mainChapterQuestIds,
            "4": exChapterQuestIds,
        },
        practiceQuestChallengeCount: 31,
        leaderClearCounts: { "121033": { all: 37, multi: 5 } },
        conditionalBattleFacts: {},
        loadoutBattleFacts: {},
        characterStoryQuestIds: { "141003": [700001] },
        characters: {
            "141003": {
                rarity: 5,
                exp: 1_000_000,
                evolutionLevel: 1,
                overLimitStep: 2,
                bondTokenList: [{ status: 1 }],
            },
        },
        equipment: [{ level: 5, maxLevel: 5, enhancementLevel: 20 }],
        manaNodes: { "141003": [101, 201] },
        manaBoardNodes: { "141003": { "2": [201] } },
        manaNodeSlots: { "141003": { "101": 1, "201": 2 } },
        partyAbilitySoulCount: 41,
        treasureShopPurchaseCount: 43,
        bossCoinShopPurchaseCount: 47,
        bossCoinEquipmentShopPurchaseCount: 53,
        totalUsedManaCount: 59,
        totalGachaCharacterCount: 61,
        totalEquipmentEquipCount: 67,
        totalUnisonSetCount: 71,
        totalPartyCharacterSetCount: 73,
        totalInjectedExpCount: 79,
        totalGachaCampaignCount: 83,
    }
    return { state, activeMissions }
}

test("pure evaluator matches all 96 snapshot definitions and preserves the 86/10 boundary", () => {
    const { evaluateActiveMissionFact } = require("../src/lib/mission/active-fact-evaluator")
    const legacy = require("./helpers/active-mission-legacy-evaluator.cjs")
    const plan = getActiveMissionPlan()
    const definitions = Object.entries(bundledMissions)
        .map(([missionId, rows]) => ({ missionId: Number(missionId), row: rows[0] }))
        .sort((left, right) => left.missionId - right.missionId)
    const { state, activeMissions } = buildFixture(definitions, legacy.resolveActiveMissionQuestIds)

    assert.equal(definitions.length, 96)
    const results = definitions.map(definition => ({
        missionId: definition.missionId,
        legacy: legacy.computeAuthoritativeProgress(
            definition,
            state,
            activeMissions,
            bundledRewards,
        ),
        evaluated: evaluateActiveMissionFact(plan.getMission(definition.missionId), state, activeMissions),
    }))
    for (const result of results) {
        assert.equal(result.evaluated, result.legacy, `mission ${result.missionId}`)
    }

    const unsupported = results.filter(result => UNSUPPORTED_MISSION_IDS.includes(result.missionId))
    assert.deepEqual(unsupported.map(result => result.missionId), UNSUPPORTED_MISSION_IDS)
    assert.equal(unsupported.every(result => result.legacy === null && result.evaluated === null), true)
    const supported = results.filter(result => !UNSUPPORTED_MISSION_IDS.includes(result.missionId))
    assert.equal(supported.length, 86)
    assert.deepEqual(
        supported.filter(result => result.evaluated === null).map(result => result.missionId),
        [20001],
        "pattern 74 is a supported external producer but reconciliation must leave it untouched",
    )
})

test("legacy oracle is frozen and independent from Task 34.5 production modules", () => {
    const oraclePath = path.join(__dirname, "helpers/active-mission-legacy-evaluator.cjs")
    const source = fs.readFileSync(oraclePath, "utf8")
    const expectedHash = fs.readFileSync(
        path.join(__dirname, "perf/__snapshots__/active_mission_legacy_oracle.sha256"),
        "utf8",
    ).trim()
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(oraclePath)).digest("hex"), expectedHash)
    for (const forbidden of [
        "active-fact-evaluator",
        "active-quest-range",
        "active-reconciliation",
        "targetMissionRequirements",
        "child_process",
        "git show",
    ]) assert.equal(source.includes(forbidden), false, forbidden)
})

test("QuestRange matches Main, Ex, WorldStoryEvent and normalized Ex IDs", () => {
    const {
        matchesActiveMissionQuestRange,
        parseActiveMissionQuestRange,
    } = require("../src/lib/mission/active-quest-range")
    const row = (kind, first, second, third) => {
        const values = []
        values[34] = kind
        values[35] = first
        values[36] = second
        values[37] = third
        return values
    }

    const main = parseActiveMissionQuestRange(row("0", "1", "8", "4"))
    assert.equal(matchesActiveMissionQuestRange(main, 1, 1_008_004), true)
    assert.equal(matchesActiveMissionQuestRange(main, 4, 1_008_004), false)

    const ex = parseActiveMissionQuestRange(row("1", "1", "8", "1"))
    assert.equal(matchesActiveMissionQuestRange(ex, 4, 1_008_001), true)
    assert.equal(matchesActiveMissionQuestRange(ex, 4, 11_008_001), true)

    const worldStory = parseActiveMissionQuestRange(row("9", "500005", "", "1"))
    assert.equal(matchesActiveMissionQuestRange(worldStory, 18, 500_005_001), true)
    assert.equal(matchesActiveMissionQuestRange(worldStory, 18, 500_005_002), false)
})

test("QuestRange distinguishes null selectors, empty selectors and no range", () => {
    const {
        matchesActiveMissionQuestRange,
        matchesPlannedActiveMissionQuestRange,
        matchesRawActiveMissionQuestRange,
        parseActiveMissionQuestRange,
        resolveRawActiveMissionQuestIds,
    } = require("../src/lib/mission/active-quest-range")
    const row = (first, second, third) => {
        const values = []
        values[34] = "2"
        values[35] = first
        values[36] = second
        values[37] = third
        return values
    }

    const nullSelectors = parseActiveMissionQuestRange(row("(None)", null, undefined))
    assert.equal(matchesActiveMissionQuestRange(nullSelectors, 2, 9_008_007), true)

    const emptySelector = parseActiveMissionQuestRange(row("", "(None)", "(None)"))
    assert.equal(matchesActiveMissionQuestRange(emptySelector, 2, 9_008_007), false)
    assert.equal(matchesActiveMissionQuestRange(null, 27, 123), true)
    assert.equal(matchesPlannedActiveMissionQuestRange(nullSelectors, 2, 9_008_007), true)
    const unknownKind = []
    unknownKind[34] = "99"
    assert.equal(matchesRawActiveMissionQuestRange(unknownKind, 1, 1_001_001), false)

    const emptyKind = []
    emptyKind[34] = ""
    emptyKind[35] = "1"
    emptyKind[36] = "8"
    emptyKind[37] = "4"
    assert.equal(matchesRawActiveMissionQuestRange(emptyKind, 1, 1_008_004), true)
    assert.deepEqual(resolveRawActiveMissionQuestIds(emptyKind), [1_008_004])
    assert.throws(() => parseActiveMissionQuestRange(emptyKind), /quest range kind/i)
    const unknownResolveKind = []
    unknownResolveKind[34] = "99"
    assert.throws(() => resolveRawActiveMissionQuestIds(unknownResolveKind), /Unsupported.*range kind/i)
    const missingResolveKind = []
    assert.throws(() => resolveRawActiveMissionQuestIds(missingResolveKind), /Missing.*range kind/i)
})
