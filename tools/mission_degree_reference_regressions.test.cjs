"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")
const { BUNDLED_CDN_CATALOG_VERSION } = require("../src/content/constants")
const { characterExpCaps } = require("../src/lib/character")
const {
    countAbilitySoulEquipments,
    getAbilitySoulEquipMissionIds,
} = require("../src/lib/mission/degree-operation-facts")
const {
    DegreeComputer,
    allFacts,
    buildDegreeRuleCatalog,
    bundledMissionContentRepository,
    character,
    createSession,
    getMissionCatalog,
} = require("./helpers/mission-degree-session-fixture.cjs")

const DEGREE_IDS = [
    3000, 32000, 32010, 32020, 62330, 62370, 62410, 62450, 62530,
    8000, 14000, 15020, 35000, 35010, 35020, 39000, 41000,
]
const ROBOT_QUESTS = new Map([
    [62330, 1001001],
    [62370, 1004001],
    [62410, 1002001],
    [62450, 1005001],
    [62530, 1006001],
])

test("locks official Degree reference rules and bundled CN selectors", () => {
    assert.equal(BUNDLED_CDN_CATALOG_VERSION, "1.4.54")
    const catalog = getMissionCatalog(bundledMissionContentRepository)
    const rules = buildDegreeRuleCatalog(catalog, DEGREE_IDS).rules
    const craftPointItemId = Number(
        bundledMissionContentRepository.table("config.json").craft_point_item_id,
    )

    assert.equal(craftPointItemId, 100000)
    assert.deepEqual([...rules.keys()], DEGREE_IDS)
    assert.deepEqual(rules.get(3000), {
        missionId: 3000,
        pattern: "degree_character_lv_growth_1",
        kind: "maxCharacterLevel",
        facts: [{ kind: "characters" }],
        targetProgress: 60,
    })
    assert.deepEqual(rules.get(32000), degreeMetric(
        32000, "degree_condition_party_force_1", "partyPowerMax", 3000,
    ))
    assert.deepEqual(rules.get(32010), degreeMetric(
        32010, "degree_condition_party_force_2", "partyPowerMax", 7500,
    ))
    assert.deepEqual(rules.get(32020), degreeMetric(
        32020, "degree_condition_party_force_3", "partyPowerMax", 8500,
    ))
    for (const [missionId, questId] of ROBOT_QUESTS) {
        assert.deepEqual(rules.get(missionId), {
            missionId,
            pattern: catalog.getDefinition(5, missionId).pattern,
            kind: "finishedQuest",
            section: 26,
            questId,
            facts: [{ kind: "questProgress", sections: [26] }],
            targetProgress: 1,
        })
    }
    assert.deepEqual(rules.get(14000), {
        missionId: 14000,
        pattern: "degree_score_clear_single_1",
        kind: "metric",
        metric: "singleScoreMax",
        replace: false,
        target: 10000000,
        facts: [{ kind: "missionBattleCounters" }],
        targetProgress: 10000000,
    })
    assert.deepEqual(rules.get(15020), {
        missionId: 15020,
        pattern: "degree_time_clear_single_3",
        kind: "singleClearTime",
        targetMs: 5000,
        target: 5000,
        facts: [{ kind: "missionBattleCounters" }],
        targetProgress: 1,
    })
    assert.deepEqual(rules.get(35000), degreeMetric(
        35000, "degree_damage_onetime_1", "damageDealMax", 1000000,
    ))
    assert.deepEqual(rules.get(35010), degreeMetric(
        35010, "degree_damage_onetime_2", "damageDealMax", 5000000,
    ))
    assert.deepEqual(rules.get(35020), degreeMetric(
        35020, "degree_damage_onetime_3", "damageDealMax", 15000000,
    ))
    assert.deepEqual(rules.get(39000), degreeMetric(
        39000, "degree_return_coffin_count_30over_1", "revivalCoffinMax", 30,
    ))
    assert.deepEqual(rules.get(41000), {
        missionId: 41000,
        pattern: "degree_craft_point_get_1",
        kind: "metric",
        metric: "craftPointObtainedCount",
        replace: false,
        target: 1000,
        facts: [{ kind: "collectedItems", itemIds: [craftPointItemId] }],
        targetProgress: 1000,
    })
    assert.deepEqual(rules.get(8000), {
        missionId: 8000,
        pattern: "degree_abilitiesoul_use_1",
        facts: [],
        targetProgress: 3,
        kind: "persisted",
    })
    assert.deepEqual(getAbilitySoulEquipMissionIds().degree, [8000, 8010, 8020])
})

test("computes the reference matrix from one official evaluation session", () => {
    const catalog = getMissionCatalog(bundledMissionContentRepository)
    const characters = bundledMissionContentRepository.table("character.json")
    const levelCharacter = Object.entries(characters)
        .find(([, data]) => Number(data.rarity) === 3)
    assert.ok(levelCharacter)
    const [levelCharacterId] = levelCharacter
    const level60Experience = characterExpCaps[3][0]
    const questProgress = [...ROBOT_QUESTS.values()].map(questId => ({
        questId,
        finished: true,
    }))
    const craftPointItemId = Number(
        bundledMissionContentRepository.table("config.json").craft_point_item_id,
    )
    const session = createSession(catalog, DEGREE_IDS, allFacts({
        characters: {
            [levelCharacterId]: character({ exp: level60Experience }),
        },
        missionBattleCounters: {
            singleScoreMax: 10000000,
            singleClearTimeMin: 5000,
        },
        degreeBattleStats: {
            partyPowerMax: 9000,
            damageDealMax: 15000000,
            revivalCoffinMax: 30,
        },
        questProgress: {
            2: questProgress,
            26: questProgress,
        },
        collectedItems: { [craftPointItemId]: 1000 },
    }))
    const context = DegreeComputer.buildContextFromSession(session, 5, DEGREE_IDS)

    const expectedProgress = new Map([
        [3000, 60],
        [32000, 9000],
        [32010, 9000],
        [32020, 9000],
        ...[...ROBOT_QUESTS.keys()].map(missionId => [missionId, 1]),
        [8000, 3],
        [14000, 10000000],
        [15020, 1],
        [35000, 15000000],
        [35010, 15000000],
        [35020, 15000000],
        [39000, 30],
        [41000, 1000],
    ])
    for (const [missionId, expected] of expectedProgress) {
        assert.equal(
            DegreeComputer.compute(missionId, context, missionId === 8000 ? 3 : 0),
            expected,
            `Degree ${missionId}`,
        )
    }
})

test("wrong facts and persisted ability-soul boundaries stay inert", () => {
    const catalog = getMissionCatalog(bundledMissionContentRepository)
    const questProgress = [...ROBOT_QUESTS.values()].map(questId => ({
        questId,
        finished: true,
    }))
    const session = createSession(catalog, DEGREE_IDS, allFacts({
        missionBattleCounters: {
            multiClearCount: 99,
            multiHostClearCount: 99,
            singleClearTimeMin: 0,
        },
        questProgress: { 2: questProgress },
    }))
    const context = DegreeComputer.buildContextFromSession(session, 5, DEGREE_IDS)

    for (const missionId of ROBOT_QUESTS.keys()) {
        assert.equal(DegreeComputer.compute(missionId, context, 0), 0)
    }
    assert.equal(DegreeComputer.compute(15020, context, 0), 0)
    assert.equal(DegreeComputer.compute(8000, context, 0), 0)
})

test("counts only new or replaced ability soul equipment", () => {
    const cases = [
        [[], [{ abilitySoulIds: [1001] }], 1],
        [[{ abilitySoulIds: [1001] }], [{ abilitySoulIds: [1002] }], 1],
        [
            [{ abilitySoulIds: [null, 1001] }],
            [{ abilitySoulIds: [1001, 1001] }],
            1,
        ],
        [[{ abilitySoulIds: [1001, 1002] }], [{ abilitySoulIds: [1001, null] }], 0],
        [[{ abilitySoulIds: [1001] }], [{ abilitySoulIds: [1001] }], 0],
    ]
    for (const [previous, current, expected] of cases) {
        assert.equal(countAbilitySoulEquipments(previous, current), expected)
    }
})

function degreeMetric(missionId, pattern, metric, targetProgress) {
    return {
        missionId,
        pattern,
        kind: "metric",
        metric,
        replace: false,
        facts: [{ kind: "degreeBattleStats" }],
        targetProgress,
    }
}
