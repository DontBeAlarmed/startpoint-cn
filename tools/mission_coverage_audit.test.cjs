const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
process.once("exit", () => { restoreContentSnapshot() })

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
    assert.equal(report.schemaVersion, 2)

    assertPartition(report.regular)
    assert.deepEqual(
        { total: report.regular.total, automated: report.regular.automated, fallback: report.regular.fallback },
        { total: 120, automated: 118, fallback: 2 },
    )
    assert.deepEqual(
        report.regular.fallbackMissions.map(entry => [entry.missionId, entry.reason]),
        [
            [100, "rescue-source-unavailable"],
            [107, "external-social-check-not-supported"],
        ],
    )

    assertPartition(report.event)
    assert.deepEqual(
        { total: report.event.total, automated: report.event.automated, fallback: report.event.fallback },
        { total: 2512, automated: 2485, fallback: 27 },
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
    assert.equal(
        report.event.automatedMissions.some(entry => entry.missionId === 1400),
        true,
        "经过审计的 type16 空 selector 任务必须进入兼容事实覆盖",
    )
    assert.deepEqual(
        report.event.automatedMissions
            .filter(entry => [
                600002, 600003, 900653, 900728, 900793,
                900810, 900811, 900812, 900813, 900814,
            ].includes(entry.missionId))
            .map(entry => entry.missionId),
        [600002, 600003, 900653, 900728, 900793, 900810, 900811, 900812, 900813, 900814],
        "10 条 type87 HardMulti 战斗条件必须进入自动事实覆盖",
    )
    assert.deepEqual(
        report.event.fallbackMissions.reduce((counts, entry) => {
            counts[entry.reason] = (counts[entry.reason] ?? 0) + 1
            return counts
        }, {}),
        {
            "rescue-source-unavailable": 27,
        },
        "type 80/81/82 的 12 条 RAID SET 任务不得继续留在 fallback 原因分区",
    )

    assertPartition(report.degree)
    assert.deepEqual(
        { total: report.degree.total, automated: report.degree.automated, fallback: report.degree.fallback },
        { total: 1288, automated: 1288, fallback: 0 },
    )
    assert.deepEqual(
        report.degree.automatedMissions
            .filter(entry => [3000, 3010, 3020].includes(entry.missionId))
            .map(entry => entry.missionId),
        [3000, 3010, 3020],
        "Lv60/Lv80/Lv100 角色等级称号必须进入权威自动覆盖",
    )
    assert.deepEqual(
        report.degree.automatedMissions
            .filter(entry => [47000, 48000, 49000, 50000].includes(entry.missionId))
            .map(entry => entry.missionId),
        [47000, 48000, 49000, 50000],
        "四条 Degree 客户端进度必须全部进入权威自动覆盖",
    )
    assert.equal(report.degree.fallbackMissions.some(entry => [3000, 3010, 3020].includes(entry.missionId)), false)
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
        { total: 267, automated: 248, fallback: 19 },
    )
    assert.deepEqual(
        report.pass.fallbackMissions.reduce((counts, entry) => {
            counts[entry.reason] = (counts[entry.reason] ?? 0) + 1
            return counts
        }, {}),
        { "rescue-source-unavailable": 19 },
    )

    assertPartition(report.daily)
    assert.deepEqual(
        { total: report.daily.total, automated: report.daily.automated, fallback: report.daily.fallback },
        { total: 656, automated: 651, fallback: 5 },
    )
    assert.deepEqual(
        report.daily.automatedMissions
            .filter(entry => [
                2, 7, 12, 10075, 800115, 800116, 800117, 800124, 800125, 800126, 800392,
            ].includes(entry.missionId))
            .map(entry => entry.missionId),
            [2, 7, 12, 10075, 800115, 800116, 800117, 800124, 800125, 800126, 800392],
        "每日战斗生产者名单与 all-clear 依赖批次必须全部进入自动覆盖",
    )
    assert.deepEqual(
        report.daily.fallbackMissions.reduce((counts, entry) => {
            counts[entry.reason] = (counts[entry.reason] ?? 0) + 1
            return counts
        }, {}),
        {
            "rescue-source-unavailable": 5,
        },
    )

    assertPartition(report.collect)
    assert.equal(
        report.collect.automatedMissions.filter(entry => entry.missionId === 1660).length,
        1,
        "收集表全清依赖任务(如 1660)必须进入依赖结算覆盖",
    )
    assert.deepEqual(
        report.collect.fallbackMissions.map(entry => [entry.missionId, entry.reason]),
        [],
        "收集表 2089(窗口登录日,1225 机制按事件泛化)与 10166(个人资料查看,get_my_profile 事实)补全后零回落",
    )
    assert.deepEqual(
        { total: report.collect.total, automated: report.collect.automated, fallback: report.collect.fallback },
        { total: 997, automated: 997, fallback: 0 },
    )


    assertPartition(report.weekly)
    assert.deepEqual(
        { total: report.weekly.total, automated: report.weekly.automated, fallback: report.weekly.fallback },
        { total: 2, automated: 2, fallback: 0 },
    )
})

test("mission coverage audit leaves no ID in both sides of a partition", () => {
    const report = getMissionCoverageAudit()
    for (const section of [
        report.regular,
        report.daily,
        report.event,
        report.collect,
        report.degree,
        report.pass,
        report.weekly,
    ]) {
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
