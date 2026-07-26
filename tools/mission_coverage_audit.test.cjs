const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

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
        { total: 2512, automated: 1485, fallback: 1027 },
    )
    assert.equal(report.event.fallbackMissions.find(entry => entry.missionId === 1200)?.patternType, 28)
    assert.equal(report.event.fallbackMissions.find(entry => entry.missionId === 1400)?.reason, "empty-quest-selector")

    assertPartition(report.degree)
    assert.deepEqual(
        { total: report.degree.total, automated: report.degree.automated, fallback: report.degree.fallback },
        { total: 1288, automated: 1268, fallback: 20 },
    )
    assert.equal(report.degree.fallbackMissions.find(entry => entry.missionId === 3000)?.patternType, 5)

    assert.deepEqual(report.awake, {
        total: 144,
        routed: 144,
        unresolvedMissionIds: [],
    })

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
