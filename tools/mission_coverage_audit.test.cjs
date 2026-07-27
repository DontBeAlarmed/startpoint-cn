const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    getProducerBackedEventEntryMissionIds,
} = require("../src/lib/mission/event-entry-facts")
const { getMissionCoverageAudit } = require("../src/lib/mission/coverage-audit")

function assertPartition(section) {
    assert.equal(section.automated + section.fallback, section.total)
    assert.equal(section.automatedMissions.length, section.automated)
    assert.equal(section.fallbackMissions.length, section.fallback)
    const key = entry => `${entry.category}:${entry.missionId}`
    assert.equal(new Set(section.automatedMissions.map(key)).size, section.automated)
    assert.equal(new Set(section.fallbackMissions.map(key)).size, section.fallback)
    assert.deepEqual(section.automatedMissions, [...section.automatedMissions].sort((left, right) => (
        left.category - right.category || left.missionId - right.missionId
    )))
    assert.equal(section.fallbackMissions.every(entry => entry.reason.length > 0), true)
}

test("mission coverage audit reproduces current authoritative partitions", () => {
    const report = getMissionCoverageAudit()
    assert.equal(report.schemaVersion, 1)

    assertPartition(report.event)
    assert.deepEqual(
        { total: report.event.total, automated: report.event.automated, fallback: report.event.fallback },
        { total: 2512, automated: 1527, fallback: 985 },
    )
    assert.equal(report.event.automatedMissions.filter(entry => [1200, 1208, 1209, 1210, 1211, 1216, 1223].includes(entry.missionId)).length, 7)
    assert.deepEqual(
        report.event.automatedMissions
            .filter(entry => [
                1225,
                2389,
                400053, 400054, 400055, 400056,
                400071, 400072, 400073, 400074,
                400089, 400090, 400091, 400092,
                400093, 400094, 400095, 400096,
            ].includes(entry.missionId))
            .map(entry => entry.missionId),
        [
            1225,
            2389,
            400053, 400054, 400055, 400056,
            400071, 400072, 400073, 400074,
            400089, 400090, 400091, 400092,
            400093, 400094, 400095, 400096,
        ],
        "Event 登录、角色投票、Raid summary 与 RAID SET 保存事实必须全部进入权威自动覆盖",
    )
    const currentStateMissionIds = [
        1201, 1202, 1203, 1204, 1205, 1206, 1207,
        1212, 1217, 1218, 1219, 1220, 1305, 1306, 1307,
    ]
    assert.deepEqual(
        report.event.automatedMissions
            .filter(entry => currentStateMissionIds.includes(entry.missionId))
            .map(entry => entry.missionId),
        currentStateMissionIds,
        "15 条 Event 当前状态任务必须全部进入权威自动覆盖",
    )
    assert.equal(report.event.fallbackMissions.find(entry => entry.missionId === 1400)?.reason, "empty-quest-selector")
    assert.deepEqual(
        report.event.fallbackMissions.reduce((counts, entry) => {
            counts[entry.reason] = (counts[entry.reason] ?? 0) + 1
            return counts
        }, {}),
        {
            "empty-quest-selector": 948,
            "rescue-source-unavailable": 27,
            "authoritative-event-fact-unavailable:type-87": 10,
        },
        "type 80/81/82 的 12 条 RAID SET 任务不得继续留在 fallback 原因分区",
    )

    assertPartition(report.degree)
    assert.deepEqual(
        { total: report.degree.total, automated: report.degree.automated, fallback: report.degree.fallback },
        { total: 1288, automated: 1274, fallback: 14 },
    )
    assert.deepEqual(
        report.degree.automatedMissions
            .filter(entry => [3010, 3020].includes(entry.missionId))
            .map(entry => entry.missionId),
        [3010, 3020],
        "Lv80/Lv100 角色等级称号必须进入权威自动覆盖",
    )
    assert.deepEqual(
        report.degree.automatedMissions
            .filter(entry => [47000, 48000, 49000, 50000].includes(entry.missionId))
            .map(entry => entry.missionId),
        [47000, 48000, 49000, 50000],
        "四条 Degree 客户端进度必须全部进入权威自动覆盖",
    )
    assert.equal(report.degree.fallbackMissions.find(entry => entry.missionId === 3000)?.patternType, 5)
    assert.equal(report.degree.fallbackMissions.some(entry => [3010, 3020].includes(entry.missionId)), false)
    assert.deepEqual(
        report.degree.fallbackMissions.reduce((counts, entry) => {
            counts[entry.reason] = (counts[entry.reason] ?? 0) + 1
            return counts
        }, {}),
        {
            "character-level-curve-incomplete": 1,
            "ability-soul-operation-semantics-unverified": 3,
            "boss-difficulty-master-data-unavailable": 1,
            "attention-source-unavailable": 3,
            "mvp-result-unavailable": 3,
            "newbie-classification-unavailable": 3,
        },
        "称号 fallback 必须按真实外部阻塞原因分类",
    )

    assert.equal(report.awake.total, 144)
    assert.equal(report.awake.routed, 144)
    assert.equal(report.awake.resolved, 144)
    assert.equal(report.awake.failClosed, 0)
    assert.deepEqual(report.awake.unresolvedMissionIds, [])
    assert.deepEqual(
        report.awake.families
            .filter(family => family.status === "fail-closed")
            .map(family => family.family),
        [],
    )
    const awakeMissionIds = report.awake.families.flatMap(family => family.missionIds)
    assert.equal(awakeMissionIds.length, 144)
    assert.equal(new Set(awakeMissionIds).size, 144)
    assert.equal(report.awake.families.every(family => (
        family.missionIds.length > 0
        && (family.status === "resolved" || family.reason.length > 0)
    )), true)

    assertPartition(report.pass)
    assert.deepEqual(
        { total: report.pass.total, automated: report.pass.automated, fallback: report.pass.fallback },
        { total: 267, automated: 229, fallback: 38 },
    )
    assert.deepEqual(
        report.pass.fallbackMissions.reduce((counts, entry) => {
            counts[entry.reason] = (counts[entry.reason] ?? 0) + 1
            return counts
        }, {}),
        { "rescue-source-unavailable": 19, "battle-emotion-source-unavailable": 19 },
    )
})

test("mission coverage audit leaves no ID in both sides of a partition", () => {
    const report = getMissionCoverageAudit()
    for (const section of [report.event, report.degree, report.pass]) {
        const automated = new Set(section.automatedMissions.map(entry => (
            `${entry.category}:${entry.missionId}`
        )))
        assert.equal(section.fallbackMissions.some(entry => (
            automated.has(`${entry.category}:${entry.missionId}`)
        )), false)
    }
})

test("mission coverage audit includes the complete producer-backed Event entry contract", () => {
    const automated = new Set(getMissionCoverageAudit().event.automatedMissions.map(entry => (
        entry.missionId
    )))
    assert.deepEqual(
        getProducerBackedEventEntryMissionIds().filter(missionId => automated.has(missionId)),
        getProducerBackedEventEntryMissionIds(),
    )
})
