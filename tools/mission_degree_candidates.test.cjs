"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")

const {
    installBundledGameplaySnapshot,
} = require("./helpers/install-bundled-gameplay-snapshot.cjs")

function degreeDefinition(pattern, conditionType, characterId = "(None)") {
    const row = Array(36).fill("")
    row[1] = pattern
    row[3] = String(conditionType)
    row[15] = characterId
    row[26] = "(None)"
    row[27] = "(None)"
    return [row]
}

function degreeRewards(table) {
    return Object.fromEntries(Object.keys(table).map(missionId => {
        const row = []
        row[0] = missionId
        row[1] = "1"
        return [missionId, { 1: [row] }]
    }))
}

function installDegreeSnapshot(table) {
    return installBundledGameplaySnapshot({
        tableOverrides: {
            "mission_degree.json": table,
            "mission_degree_reward.json": degreeRewards(table),
        },
    })
}

const firstTable = {
    30: degreeDefinition("degree_rank_second", 1),
    10: degreeDefinition("degree_rank_first", 1),
    400: degreeDefinition("degree_favor_main", 44, "111001"),
    401: degreeDefinition("degree_favor_sub", 44, 111002),
    402: degreeDefinition("degree_favor_unknown", 44, "(None)"),
    403: degreeDefinition("degree_favor_other", 44, 111003),
    500: degreeDefinition("degree_unrelated", 99),
}

let restoreSnapshot = installDegreeSnapshot(firstTable)
try {
    let candidateModule = {}
    try {
        candidateModule = require("../src/lib/mission/degree-candidates")
    } catch (error) {
        if (error.code !== "MODULE_NOT_FOUND") throw error
    }
    assert.equal(
        typeof candidateModule.getDegreeMissionIdsForConditionTypes,
        "function",
        "称号候选模块必须导出 condition type 反向查询",
    )
    const { getDegreeMissionIdsForConditionTypes } = candidateModule

    assert.deepEqual(
        getDegreeMissionIdsForConditionTypes([]),
        [],
        "空 condition type 不得退化为全量称号",
    )
    assert.deepEqual(
        getDegreeMissionIdsForConditionTypes([44]),
        [],
        "未提供角色集合时 type 44 必须 fail closed",
    )
    assert.deepEqual(
        getDegreeMissionIdsForConditionTypes([44], []),
        [],
        "空角色集合不得放开任何 type 44 称号",
    )
    assert.deepEqual(
        getDegreeMissionIdsForConditionTypes([44, 1, 44], [111002, 111001, 111002]),
        [10, 30, 400, 401],
        "候选必须稳定去重，并同时保留 main/Sub 对应的 type 44",
    )
    assert.deepEqual(
        getDegreeMissionIdsForConditionTypes([44], [111001]),
        [400],
        "type 44 目标字段无法权威解析时必须 fail closed",
    )

    restoreSnapshot()
    restoreSnapshot = installDegreeSnapshot({
        700: degreeDefinition("degree_runtime_replacement", 1),
    })
    assert.deepEqual(
        getDegreeMissionIdsForConditionTypes([1]),
        [700],
        "反向索引必须跟随当前 Runtime Content snapshot",
    )
} finally {
    restoreSnapshot()
}

console.log("mission degree candidate tests passed")
