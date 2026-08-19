require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { getActiveMissionPlan } = require("../src/lib/mission/active-plan")
const {
    ACTIVE_MISSION_FACT_KINDS,
    createActiveMissionFactSession,
} = require("../src/lib/mission/active-fact-session")
const { runActiveMissionReconciliation } = require("../src/lib/mission/active-reconciliation-runner")

function missionRow({ pattern, phase = 1, missionIds = "", questKind = "(None)", questA = "", questB = "", questC = "" }) {
    const row = []
    row[0] = "901"
    row[1] = String(phase)
    row[3] = `fixed_point_${pattern}_${phase}_${missionIds}`
    row[29] = String(pattern)
    row[34] = String(questKind)
    row[35] = String(questA)
    row[36] = String(questB)
    row[37] = String(questC)
    row[55] = missionIds
    row[56] = "(None)"
    row[58] = "(None)"
    row[60] = "2020-01-01 00:00:00"
    row[61] = "(None)"
    row[62] = "2020-01-01 00:00:00"
    row[63] = "(None)"
    return row
}

function eventRow() {
    const row = []
    row[0] = "fixed_point_event"
    row[2] = "0"
    row[3] = "2"
    row[14] = "2020-01-01 00:00:00"
    row[15] = "(None)"
    row[22] = "(None)"
    return row
}

function rewardRow(targetProgress) {
    const row = []
    row[3] = String(targetProgress)
    row[4] = "(None)"
    row[7] = "0"
    row[8] = "1"
    return row
}

function createRepository() {
    const targetIds = "90001,90002,90003,90004,90005,90006"
    const tables = {
        "mission_active.json": {
            90001: [missionRow({ pattern: 57, questKind: 0, questA: 1, questB: 8, questC: 4 })],
            90002: [missionRow({ pattern: 74 })],
            90003: [missionRow({ pattern: 74 })],
            90004: [missionRow({ pattern: 0 })],
            90005: [missionRow({ pattern: 74 })],
            90006: [missionRow({ pattern: 13, missionIds: "90001" })],
            90007: [missionRow({ pattern: 13, phase: 2, missionIds: targetIds })],
        },
        "mission_active_event.json": { 901: [eventRow()] },
        "mission_active_reward.json": {
            90001: { 1: [rewardRow(1)] },
            90002: { 1: [rewardRow(1)] },
            90003: { 1: [rewardRow(1)] },
            90004: { 1: [rewardRow(3)] },
            90005: { 1: [rewardRow(1)] },
            90006: { 1: [rewardRow(1)] },
            90007: { 1: [rewardRow(6)] },
        },
        "main_quest.json": {},
        "ex_quest.json": {},
    }
    return {
        info: () => ({ source: "release", assetVersion: "fixed-point-test", contentVersion: 1 }),
        table: tableName => {
            if (!(tableName in tables)) throw new Error(`unexpected table ${tableName}`)
            return tables[tableName]
        },
    }
}

function subsetPlan(sourcePlan, definitions) {
    const missions = new Map(definitions.map(definition => [definition.missionId, definition]))
    return {
        definitions,
        getMission: missionId => missions.get(missionId),
        getEvent: eventId => sourcePlan.getEvent(eventId),
        getDefinitionsByPattern: pattern => definitions.filter(definition => definition.pattern === pattern),
        getUnsupportedMissionIds: () => [],
    }
}

function createSession(plan, activeMissions, facts = {}) {
    const domains = Object.fromEntries(ACTIVE_MISSION_FACT_KINDS.map(kind => [kind, () => ({ rows: 0 })]))
    domains.activeProgress = () => ({ rows: Object.keys(activeMissions).length, activeMissions })
    domains.questProgress = () => ({
        rows: 1,
        questProgressByCategory: { 1: [{ questId: 1008004, finished: true }] },
    })
    domains.player = () => ({ rows: 1, facts: { player: { totalLoginDays: 3, totalStaminaUsed: 0 } } })
    if (facts.conditionalBattleFacts) {
        domains.conditionalBattleFacts = () => ({
            rows: 1,
            facts: { conditionalBattleFacts: facts.conditionalBattleFacts },
        })
    }
    return createActiveMissionFactSession({ playerId: 1, plan, domains })
}

test("runner loads candidate facts only after availability", () => {
    const sourcePlan = getActiveMissionPlan()
    const availableSource = sourcePlan.getMission(20003)
    const available = {
        ...availableSource,
        mission: { ...availableSource.mission, need: undefined, show: undefined },
    }
    const unavailableSource = sourcePlan.getMission(20011)
    const unavailable = {
        ...unavailableSource,
        mission: {
            ...unavailableSource.mission,
            enableStartTime: Date.parse("2024-08-15T00:00:00.000Z"),
        },
    }
    const plan = subsetPlan(sourcePlan, [available, unavailable])
    const session = createSession(plan, {
        20002: { progress: 1, stages: { 1: true } },
        20003: { progress: 0, stages: {} },
        20011: { progress: 0, stages: {} },
    }, { conditionalBattleFacts: {} })

    runActiveMissionReconciliation({
        playerId: 1,
        repository: {},
        now: Date.parse("2024-08-14T12:00:00.000Z"),
        plan,
        session,
        updateMission() {},
        updateStage() {},
    })

    const loadedKinds = session.getLoadedKinds()
    assert.equal(loadedKinds.has("activeProgress"), true)
    assert.equal(loadedKinds.has("questProgress"), true)
    assert.equal(loadedKinds.has("conditionalBattleFacts"), true)
    assert.equal(loadedKinds.has("missionSpecificBattleFacts"), false)
})

test("runner candidate evaluation does not deep-clone session snapshots", () => {
    const sourcePlan = getActiveMissionPlan()
    const source = sourcePlan.getMission(20003)
    const definition = {
        ...source,
        mission: { ...source.mission, need: undefined, show: undefined },
    }
    const plan = subsetPlan(sourcePlan, [definition])
    const session = createSession(plan, {
        20003: { progress: 0, stages: {} },
    }, { conditionalBattleFacts: {} })
    const originalStructuredClone = global.structuredClone
    let cloneCalls = 0
    global.structuredClone = value => {
        cloneCalls++
        return originalStructuredClone(value)
    }

    try {
        runActiveMissionReconciliation({
            playerId: 1,
            repository: {},
            now: Date.parse("2024-08-14T12:00:00.000Z"),
            plan,
            session,
            updateMission() {},
            updateStage() {},
        })
    } finally {
        global.structuredClone = originalStructuredClone
    }

    assert.equal(cloneCalls, 1)
})

test("stage-only settlement does not dirty target dependency", () => {
    const sourcePlan = getActiveMissionPlan()
    const source = sourcePlan.getMission(20003)
    const dependency = sourcePlan.getMission(20006)
    const sourceDefinition = {
        ...source,
        missionId: 30004,
        pattern: 0,
        row: [...source.row].map((value, index) => index === 29 ? "0" : value),
        mission: { ...source.mission, missionId: 30004, need: undefined, show: undefined },
        rewardStages: [{ stage: 1, targetProgress: 3, rewards: [] }],
        targetMissionRequirements: [],
        factKinds: ["player"],
        evaluator: "static",
    }
    const dependencyDefinition = {
        ...dependency,
        missionId: 30006,
        pattern: 13,
        mission: { ...dependency.mission, missionId: 30006, need: undefined, show: undefined },
        row: [...dependency.row].map((value, index) => index === 29 ? "13" : value),
        rewardStages: [{ stage: 1, targetProgress: 1, rewards: [] }],
        targetMissionRequirements: [{ missionId: 30004, completionProgress: 3 }],
        factKinds: [],
        evaluator: "dependency",
    }
    const plan = subsetPlan(sourcePlan, [sourceDefinition, dependencyDefinition])
    const session = createSession(plan, {
        30004: { progress: 3, stages: {} },
        30006: { progress: 0, stages: {} },
    })
    let dependencyComputes = 0
    const writes = []
    const result = runActiveMissionReconciliation({
        playerId: 1,
        repository: {},
        now: Date.parse("2024-08-14T12:00:00.000Z"),
        plan,
        session,
        observer: { dependencyComputed() { dependencyComputes++ } },
        updateMission(missionId, progress) { writes.push(["mission", missionId, progress]) },
        updateStage(missionId, stage) { writes.push(["stage", missionId, stage]) },
    })

    assert.equal(dependencyComputes, 1)
    assert.deepEqual(writes, [
        ["mission", 30004, 3],
        ["stage", 30004, 1],
        ["mission", 30006, 1],
        ["stage", 30006, 1],
    ])
    assert.equal(result.activeMissions["30004"].progress, 3)
})

test("settlement errors escape the runner", () => {
    const sourcePlan = getActiveMissionPlan()
    const source = sourcePlan.getMission(20003)
    const definition = {
        ...source,
        missionId: 31004,
        pattern: 0,
        row: [...source.row].map((value, index) => index === 29 ? "0" : value),
        mission: { ...source.mission, missionId: 31004, need: undefined, show: undefined },
        rewardStages: [{ stage: 1, targetProgress: 1, rewards: [] }],
        targetMissionRequirements: [],
        factKinds: ["player"],
        evaluator: "static",
    }
    const plan = subsetPlan(sourcePlan, [definition])
    const domains = Object.fromEntries(ACTIVE_MISSION_FACT_KINDS.map(kind => [kind, () => ({ rows: 0 })]))
    domains.activeProgress = () => ({
        rows: 1,
        activeMissions: { 31004: { progress: 0, stages: {} } },
    })
    domains.questProgress = () => ({
        rows: 1,
        questProgressByCategory: { 1: [{ questId: 1008004, finished: true }] },
    })
    domains.player = () => ({
        rows: 1,
        facts: { player: { totalLoginDays: Number.NaN, totalStaminaUsed: 0 } },
    })
    const session = createActiveMissionFactSession({ playerId: 1, plan, domains })

    assert.throws(() => runActiveMissionReconciliation({
        playerId: 1,
        repository: {},
        now: Date.parse("2024-08-14T12:00:00.000Z"),
        plan,
        session,
        updateMission() {},
        updateStage() {},
    }), /absolute progress/i)
})

test("fixed point caches static facts and only recomputes dirty dependencies", () => {
    const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "active-mission-fixed-point-"))
    const previousDataDirectory = process.env.DATA_DIR
    const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
    process.env.DATA_DIR = databaseDirectory
    delete process.env.WDFP_DATABASE_DIR

    const data = require("../src/data")
    const { getDb } = require("../src/data/db")
    const { insertAccountSync } = require("../src/data/domains/account")
    const { updatePlayerActiveMissionSync } = require("../src/data/domains/mission")
    const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
    const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")
    const {
        reconcileActiveMissionFactsWithResult,
    } = require("../src/lib/mission/active-reconciliation")
    let db
    try {
        data.initializeDatabase()
        db = getDb()
        const account = insertAccountSync({
            appId: "wf_cn",
            idpAlias: "",
            idpCode: "fixed-point-test",
            idpId: `fixed-point-${Date.now()}`,
            status: "normal",
        })
        const playerId = insertDefaultPlayerSync(account.id).id
        updatePlayerSync({ id: playerId, totalLoginDays: 3 })
        insertPlayerQuestProgressSync(playerId, 1, {
            questId: 1008004,
            finished: true,
            unlocked: true,
        })
        for (const missionId of [90002, 90003, 90005]) {
            updatePlayerActiveMissionSync(playerId, missionId, 1)
        }

        const metrics = {
            definitionVisits: 0,
            staticComputes: {},
            dependencyComputes: {},
        }
        const observer = {
            definitionVisited() { metrics.definitionVisits++ },
            factLoaded() {},
            staticComputed(missionId) {
                metrics.staticComputes[missionId] = (metrics.staticComputes[missionId] ?? 0) + 1
            },
            dependencyComputed(missionId) {
                metrics.dependencyComputes[missionId] = (metrics.dependencyComputes[missionId] ?? 0) + 1
            },
        }
        const repository = createRepository()
        const result = reconcileActiveMissionFactsWithResult({
            playerId,
            repository,
            now: Date.parse("2024-08-14T12:00:00.000Z"),
            observer,
        })

        assert.equal(metrics.staticComputes[90001], 1)
        assert.equal(metrics.staticComputes[90004], 1)
        assert.equal(metrics.dependencyComputes[90006], 1)
        assert.equal(metrics.dependencyComputes[90007], 1)
        assert.equal(metrics.definitionVisits, 7)
        assert.ok(metrics.definitionVisits < 14, metrics)
        assert.equal(result.activeMissions[90007].progress, 6)
        assert.equal(result.deltas.find(delta => delta.mission_id === 90007).progress_value, 6)
        assert.deepEqual(result.deltas.map(delta => delta.mission_id), [90001, 90004, 90006, 90007])
    } finally {
        if (db?.open) data.closeDatabase()
        fs.rmSync(databaseDirectory, { recursive: true, force: true })
        if (previousDataDirectory === undefined) delete process.env.DATA_DIR
        else process.env.DATA_DIR = previousDataDirectory
        if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
        else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
    }
})
