"use strict"

const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const fixturePath = path.join(
    __dirname,
    "fixtures",
    "mission-degree",
    "legacy-f8be414.json",
)

function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted)
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
}

test("pre-5B Degree fixture has complete versioned compute and settlement evidence", () => {
    assert.equal(fs.existsSync(fixturePath), true, "pre-5B Degree fixture is missing")
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"))
    const { integritySha256, ...payload } = fixture

    assert.equal(fixture.schemaVersion, 1)
    assert.deepEqual(fixture.source, {
        commit: "f8be41456f719a4bf39fab9072e00bebd09b8247",
        version: "pre-5B",
        entrypoint: "src/lib/mission/computer-degree.ts",
        generator: "tools/generate_mission_degree_legacy_fixture.cjs",
    })
    assert.equal(fs.existsSync(path.join(__dirname, "generate_mission_degree_legacy_fixture.cjs")), true)
    assert.equal(fixture.compute.missionCount, 1288)
    assert.deepEqual(fixture.compute.dbProgresses, [0, 2, 31, 1_000_000_000])
    assert.deepEqual(Object.keys(fixture.compute.hashes), ["0", "2", "31", "1000000000"])
    for (const hash of Object.values(fixture.compute.hashes)) assert.match(hash, /^[a-f0-9]{64}$/)
    for (const phase of ["first", "repeated"]) {
        assert.deepEqual(Object.keys(fixture.settlement[phase].response).sort(), [
            "characterList", "degreeIds", "equipmentList", "itemList",
            "missionInfo", "passCardPoints", "userInfo",
        ])
        assert.deepEqual(Object.keys(fixture.settlement[phase].persisted).sort(), [
            "missionId", "progress", "stages",
        ])
    }
    assert.equal(integritySha256, "e2866694483a1015400e92fdd22d111ae65619bfe7927ab48c7c7cd60e737b30")
    assert.equal(
        createHash("sha256").update(JSON.stringify(sorted(payload))).digest("hex"),
        integritySha256,
    )
})
