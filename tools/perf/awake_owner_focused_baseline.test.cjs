"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
    AWAKE_OWNER_FOCUSED_SCENARIO_KEYS,
    AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY,
    SINGLE_REREAD_REASON,
} = require("./awake_owner_focused_scenarios.cjs")
const {
    createAwakeOwnerFocusedReport,
} = require("./awake_owner_focused_report.cjs")
const {
    evaluateAwakeOwnerFocusedAdmission,
} = require("./awake_owner_focused_admission.cjs")
const {
    SNAPSHOT_PATH,
    admitAwakeOwnerFocusedReport,
    parseArgs,
    runAwakeOwnerFocusedBaseline,
} = require("./awake_owner_focused_baseline.cjs")

test("owner-focused contract fixes the required deterministic scenario set", () => {
    for (const required of [
        "candidate-zero",
        "candidate-one",
        "candidate-multiple",
        "learn-mana-final-node",
        "bond-success",
        "category9-update-progress",
        "story-finish",
        "mana-item-sell",
        "reward-grant-post-commit",
        "character-grant-owner",
        "single-finish",
        "pass-card-receive-all",
        "raid-event-summary",
    ]) {
        assert.equal(AWAKE_OWNER_FOCUSED_SCENARIO_KEYS.includes(required), true, required)
    }
    assert.equal(Object.keys(AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY).length > 0, true)
})

test("admission rejects any behavior, seed, loader, compute, or per-table SQL drift", () => {
    const scenario = {
        request: { action: "candidate-zero" },
        response: { characterList: [] },
        dbBefore: { unlocks: [] },
        dbAfter: { unlocks: [] },
        characterSeeds: [],
        factSeeds: [],
        directMissionSeeds: [],
        loaderCalls: [],
        missionComputes: 0,
        snapshotSource: "none",
        rereadReason: "fresh owner state is loaded after the authoritative write",
        freshPostWriteEvaluationRequired: true,
        sqlReads: 1,
        sqlWrites: 0,
        sqlByTable: {
            players_character_awake_unlocks: { reads: 1, statements: 1, writes: 0 },
        },
    }
    const input = Object.fromEntries(AWAKE_OWNER_FOCUSED_SCENARIO_KEYS.map(key => [key, {
        ...structuredClone(scenario),
        ...(key === "single-finish" ? {
            response: { characterList: [], category9Evaluations: 2 },
            rereadReason: SINGLE_REREAD_REASON,
        } : {}),
    }]))
    const snapshot = createAwakeOwnerFocusedReport(input)
    for (const mutate of [
        report => { report.scenarios["candidate-zero"].response.changed = true },
        report => { report.scenarios["candidate-zero"].characterSeeds.push(1) },
        report => { report.scenarios["candidate-zero"].loaderCalls.push("player") },
        report => { report.scenarios["candidate-zero"].missionComputes++ },
        report => { report.scenarios["candidate-zero"].dbAfter.unlocks.push([1, []]) },
        report => { report.scenarios["candidate-zero"].sqlReads-- },
        report => { report.scenarios["candidate-zero"].sqlByTable.players_character_awake_unlocks.reads++ },
    ]) {
        const current = structuredClone(snapshot)
        mutate(current)
        assert.equal(evaluateAwakeOwnerFocusedAdmission(current, snapshot).admitted, false)
    }
})

test("CLI and admission require an explicit snapshot write", () => {
    assert.deepEqual(parseArgs([]), { write: false })
    assert.deepEqual(parseArgs(["--write"]), { write: true })
    assert.throws(() => parseArgs(["--update"]), /unknown argument/)

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "awake-owner-admit-"))
    const snapshotPath = path.join(directory, "snapshot.json")
    const scenario = {
        request: { action: "candidate-zero" },
        response: { characterList: [] },
        dbBefore: { unlocks: [] },
        dbAfter: { unlocks: [] },
        characterSeeds: [],
        factSeeds: [],
        directMissionSeeds: [],
        loaderCalls: [],
        missionComputes: 0,
        snapshotSource: "none",
        rereadReason: "fresh owner state is loaded after the authoritative write",
        freshPostWriteEvaluationRequired: true,
        sqlReads: 1,
        sqlWrites: 0,
        sqlByTable: {
            players_character_awake_unlocks: { reads: 1, statements: 1, writes: 0 },
        },
    }
    const input = Object.fromEntries(AWAKE_OWNER_FOCUSED_SCENARIO_KEYS.map(key => [key, {
        ...structuredClone(scenario),
        ...(key === "single-finish" ? {
            response: { characterList: [], category9Evaluations: 2 },
            rereadReason: SINGLE_REREAD_REASON,
        } : {}),
    }]))
    const report = createAwakeOwnerFocusedReport(input)
    try {
        assert.throws(
            () => admitAwakeOwnerFocusedReport(report, { snapshotPath }),
            /snapshot does not exist/i,
        )
        assert.equal(fs.existsSync(snapshotPath), false)
        assert.equal(admitAwakeOwnerFocusedReport(report, {
            snapshotPath,
            write: true,
        }).admitted, true)
        const original = fs.readFileSync(snapshotPath, "utf8")
        assert.equal(admitAwakeOwnerFocusedReport(report, { snapshotPath }).admitted, true)
        assert.equal(fs.readFileSync(snapshotPath, "utf8"), original)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("current owner-focused evidence exactly matches the checked snapshot", async () => {
    assert.equal(fs.existsSync(SNAPSHOT_PATH), true, "owner-focused snapshot must be created with --write")
    const report = await runAwakeOwnerFocusedBaseline()
    const admission = admitAwakeOwnerFocusedReport(report)
    assert.equal(admission.admitted, true, JSON.stringify(admission.failures))
    assert.equal(report.scenarios["single-finish"].snapshotSource, "none")
    assert.equal(report.scenarios["single-finish"].rereadReason, SINGLE_REREAD_REASON)
    assert.equal(report.scenarios["single-finish"].freshPostWriteEvaluationRequired, true)
    assert.equal(report.scenarios["single-finish"].response.category9Evaluations, 2)
    assert.deepEqual(report.scenarios["single-finish"].factSeeds, ["passState:3", "player"])
    assert.equal(report.scenarios["single-finish"].loaderCalls.length > 1, true)
    assert.deepEqual(report.scenarios["pass-card-receive-all"].dbAfter.player.totalManaObtained, 604800)
    assert.deepEqual(report.scenarios["raid-event-summary"].dbAfter.receivedUpTo, 1)
})
