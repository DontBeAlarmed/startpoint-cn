const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const admissionModule = require("../src/multi/admission/registry")
const { AdmissionRegistry } = admissionModule

function snapshotFixture(viewerId = 101, name = "Host") {
    return {
        viewerId,
        name,
        rank: 12,
        degreeId: 3,
        mainCharacterId: 101001,
        playerRoleKind: 1,
        isNewbie: false,
        currentPartyId: 1,
        party: {
            characters: [[1], [1], [1]],
            unison_characters: [[1], [1], [1]],
            equipments: [[1], [1], [1]],
            abilitySoulIds: [[1], [1], [1]],
        },
        npcParties: [],
    }
}

function issue(registry, overrides = {}) {
    return registry.issue({
        roomNumber: "123456",
        participant: { nodeSessionId: "node-a", viewerId: 101 },
        snapshot: snapshotFixture(),
        expiresAt: 6_000,
        ...overrides,
    })
}

test("consumes a matching room and viewer admission exactly once", () => {
    const registry = new AdmissionRegistry({ now: () => 1_000 })
    assert.equal(issue(registry).ok, true)

    assert.equal(registry.consume("123456", 101)?.snapshot.name, "Host")
    assert.equal(registry.consume("123456", 101), null)
})

test("wrong room or viewer does not consume the matching admission", () => {
    const registry = new AdmissionRegistry({ now: () => 1_000 })
    issue(registry)

    assert.equal(registry.consume("654321", 101), null)
    assert.equal(registry.consume("123456", 202), null)
    assert.equal(registry.consume("123456", 101)?.snapshot.name, "Host")
})

test("expired admissions return null and are removed using the injected clock", () => {
    let now = 1_000
    const registry = new AdmissionRegistry({ now: () => now })
    issue(registry)

    now = 6_000
    assert.equal(registry.consume("123456", 101), null)
    assert.equal(registry.cleanup(), 0)
})

test("rejects a different node session for the same room and viewer", () => {
    const registry = new AdmissionRegistry({ now: () => 1_000 })
    assert.equal(issue(registry).ok, true)

    assert.deepEqual(issue(registry, {
        participant: { nodeSessionId: "node-b", viewerId: 101 },
    }), { ok: false, error: "VIEWER_ID_CONFLICT" })
    assert.equal(registry.consume("123456", 101)?.participant.nodeSessionId, "node-a")
})

test("repeated prepare for the same participant is idempotent", () => {
    const registry = new AdmissionRegistry({ now: () => 1_000 })
    const first = issue(registry)
    const second = issue(registry, {
        snapshot: snapshotFixture(101, "Changed"),
        expiresAt: 7_000,
    })

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(second.value, first.value)
    assert.equal(registry.consume("123456", 101)?.snapshot.name, "Host")
    assert.equal(registry.consume("123456", 101), null)
})

test("the same viewer id can be admitted to different rooms", () => {
    const registry = new AdmissionRegistry({ now: () => 1_000 })
    assert.equal(issue(registry).ok, true)
    assert.equal(issue(registry, { roomNumber: "654321" }).ok, true)

    assert.equal(registry.consume("123456", 101)?.snapshot.viewerId, 101)
    assert.equal(registry.consume("654321", 101)?.snapshot.viewerId, 101)
})

test("validates admission identity, room, expiry and snapshot viewer", () => {
    const registry = new AdmissionRegistry({ now: () => 1_000 })
    const invalidInputs = [
        { participant: { nodeSessionId: "node-a", viewerId: 0 }, snapshot: snapshotFixture(0) },
        { participant: { nodeSessionId: "node-a", viewerId: -1 }, snapshot: snapshotFixture(-1) },
        { participant: { nodeSessionId: "node-a", viewerId: 1.5 }, snapshot: snapshotFixture(1.5) },
        { participant: { nodeSessionId: "node-a", viewerId: Number.MAX_SAFE_INTEGER + 1 }, snapshot: snapshotFixture(Number.MAX_SAFE_INTEGER + 1) },
        { participant: { nodeSessionId: "", viewerId: 101 } },
        { roomNumber: "" },
        { roomNumber: "   " },
        { expiresAt: 1_000 },
        { expiresAt: Number.NaN },
        { snapshot: snapshotFixture(202) },
    ]

    for (const overrides of invalidInputs) {
        assert.throws(() => issue(registry, overrides), TypeError)
    }
})

test("admission contract has no hidden or exported local player metadata", () => {
    const registry = new AdmissionRegistry({ now: () => 1_000 })
    issue(registry)

    const admission = registry.consume("123456", 101)
    assert.deepEqual(Object.keys(admission).sort(), [
        "expiresAt",
        "participant",
        "roomNumber",
        "snapshot",
    ])
    assert.equal("getEmbeddedAdmissionMetadata" in admissionModule, false)
    assert.equal(JSON.stringify(admission).includes("localPlayerId"), false)
})
