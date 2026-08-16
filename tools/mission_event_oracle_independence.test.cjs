"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const { createHash } = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const SOURCE_COMMIT = "d594854070718d12c3dab4a31901d5647c4bf1e9"
const fixturePath = path.join(
    __dirname,
    "fixtures",
    "mission-event",
    "legacy-d594854.json",
)

function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted)
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
}

test("Event migration oracle is fixed to the independently generated pre-Session behavior", () => {
    assert.equal(fs.existsSync(fixturePath), true, "legacy Event fixture must be generated")
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"))
    const { integritySha256, ...payload } = fixture

    assert.deepEqual(fixture.source, {
        commit: SOURCE_COMMIT,
        version: "pre-event-session",
        entrypoint: "src/lib/mission/computer-event-safe.ts",
        generator: "tools/generate_mission_event_legacy_fixture.cjs",
    })
    assert.equal(fixture.schemaVersion, 1)
    assert.equal(integritySha256, createHash("sha256")
        .update(JSON.stringify(sorted(payload)))
        .digest("hex"))
    assert.deepEqual(Object.keys(fixture.compute).sort(), [
        "aggregate",
        "currentState",
        "item",
        "persisted",
        "quest",
        "unsupported",
    ])
    assert.deepEqual(Object.keys(fixture.compute.currentState).sort(), ["available", "unavailable"])
    assert.equal(Object.keys(fixture.compute.currentState.available).length, 15)
    assert.equal(Object.keys(fixture.compute.currentState.unavailable).length, 15)
    assert.deepEqual(Object.keys(fixture.settlement).sort(), ["first", "repeated"])
})

test("Event migration oracle exactly matches a fresh d594854 generator run", { timeout: 30_000 }, () => {
    const result = spawnSync(process.execPath, [
        path.join(__dirname, "generate_mission_event_legacy_fixture.cjs"),
    ], {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.deepEqual(JSON.parse(result.stdout), JSON.parse(fs.readFileSync(fixturePath, "utf8")))
})
