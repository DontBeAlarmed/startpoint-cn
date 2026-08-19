require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const { getActiveMissionPlan } = require("../src/lib/mission/active-plan")
const {
    ACTIVE_MISSION_FACT_KINDS,
    createActiveMissionFactSession,
} = require("../src/lib/mission/active-fact-session")

test("event 2 facts load on demand and each kind loads once per session", () => {
    const plan = getActiveMissionPlan()
    const eventMissionIds = plan.definitions
        .filter(definition => definition.mission.eventId === 2)
        .map(definition => definition.missionId)
    const calls = Object.fromEntries(ACTIVE_MISSION_FACT_KINDS.map(kind => [kind, 0]))
    const domains = Object.fromEntries(ACTIVE_MISSION_FACT_KINDS.map(kind => [kind, () => {
        calls[kind]++
        return { rows: 0 }
    }]))
    const observerLoads = {}
    const session = createActiveMissionFactSession({
        playerId: 1,
        plan,
        domains,
        observer: {
            factLoaded(kind) {
                observerLoads[kind] = (observerLoads[kind] ?? 0) + 1
            },
        },
    })

    session.loadKinds(["activeProgress", "questProgress"])
    const loadedKinds = session.getLoadedKinds()
    assert.deepEqual([...loadedKinds], ["questProgress", "activeProgress"])
    loadedKinds.delete("activeProgress")
    assert.equal(session.getLoadedKinds().has("activeProgress"), true)

    session.loadFor(eventMissionIds)

    assert.equal(calls.characters, 0)
    assert.equal(calls.conditionalBattleFacts, 1)
    assert.equal(calls.battleCounters, 0)
    assert.equal(calls.shopPurchases, 0)
    assert.equal(observerLoads.characters, undefined)
    assert.equal(observerLoads.conditionalBattleFacts, 1)

    session.loadFor(eventMissionIds)
    assert.equal(calls.characters, 0)
    assert.equal(calls.conditionalBattleFacts, 1)
    assert.equal(observerLoads.characters, undefined)
    assert.equal(observerLoads.conditionalBattleFacts, 1)
})

test("unsupported and legacy no-op definitions have no fact requirements", () => {
    const plan = getActiveMissionPlan()
    for (const missionId of [...plan.getUnsupportedMissionIds(), 20001]) {
        const definition = plan.getMission(missionId)
        assert.ok(definition, `missing mission ${missionId}`)
        assert.deepEqual(definition.factKinds, [], `mission ${missionId}`)
        assert.equal(definition.evaluator, null, `mission ${missionId}`)
    }
})

test("fact loader errors escape the session", () => {
    const plan = getActiveMissionPlan()
    const domains = Object.fromEntries(ACTIVE_MISSION_FACT_KINDS.map(kind => [kind, () => ({ rows: 0 })]))
    domains.characterClear = () => {
        throw new Error("forced character-clear fact failure")
    }
    const session = createActiveMissionFactSession({ playerId: 1, plan, domains })

    assert.throws(
        () => session.loadFor([20002]),
        /forced character-clear fact failure/,
    )
})

test("session snapshots do not expose mutable internal state", () => {
    const plan = getActiveMissionPlan()
    const domains = Object.fromEntries(ACTIVE_MISSION_FACT_KINDS.map(kind => [kind, () => ({ rows: 0 })]))
    domains.activeProgress = () => ({
        rows: 1,
        activeMissions: { 1: { progress: 4, stages: {} } },
    })
    domains.questProgress = () => ({
        rows: 1,
        questProgressByCategory: { 1: [{ questId: 9, finished: true }] },
    })
    domains.characters = () => ({
        rows: 1,
        facts: {
            characters: {
                1: { exp: 10, evolutionLevel: 0, overLimitStep: 0, bondTokenList: [] },
            },
        },
    })
    const session = createActiveMissionFactSession({ playerId: 1, plan, domains })
    const exposed = session.loadKinds(["activeProgress", "questProgress", "characters"])
    exposed.activeMissions["1"].progress = 99
    exposed.activeMissions["1"].stages["1"] = true
    exposed.facts.characters["1"].exp = 99
    exposed.questProgressByCategory[1][0].finished = false

    const again = session.snapshot()
    assert.equal(again.activeMissions["1"].progress, 4)
    assert.deepEqual(again.activeMissions["1"].stages, {})
    assert.equal(again.facts.characters["1"].exp, 10)
    assert.equal(again.questProgressByCategory[1][0].finished, true)
})

test("failed loader application or observer does not consume the kind", () => {
    const plan = getActiveMissionPlan()
    const domains = Object.fromEntries(ACTIVE_MISSION_FACT_KINDS.map(kind => [kind, () => ({ rows: 0 })]))
    let calls = 0
    domains.player = () => {
        calls++
        if (calls === 1) throw new Error("forced fact loader failure")
        if (calls === 2) {
            const facts = {}
            Object.defineProperty(facts, "player", {
                enumerable: true,
                get() { throw new Error("forced fact application failure") },
            })
            return { rows: 1, facts }
        }
        return { rows: 1, facts: { player: { totalLoginDays: 7, totalStaminaUsed: 0 } } }
    }
    const session = createActiveMissionFactSession({
        playerId: 1,
        plan,
        domains,
        observer: {
            factLoaded(kind) {
                if (kind === "player" && calls === 3) {
                    throw new Error("forced fact observer failure")
                }
            },
        },
    })

    for (const pattern of [
        /forced fact loader failure/,
        /forced fact application failure/,
        /forced fact observer failure/,
    ]) {
        assert.throws(() => session.loadKinds(["player"]), pattern)
        assert.equal(session.getLoadedKinds().has("player"), false)
        assert.equal(session.snapshot().facts.player.totalLoginDays, 0)
    }

    session.loadKinds(["player"])
    assert.equal(calls, 4)
    assert.equal(session.getLoadedKinds().has("player"), true)
    assert.equal(session.snapshot().facts.player.totalLoginDays, 7)
})
