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
    assertOwnerRuntimeEvidenceCoverage,
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

function syntheticScenario(name) {
    const evidence = AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY[name]
    const seedContract = evidence.seedContract
    const owner = evidence.owners[0]
    return {
        owner,
        boundary: evidence.boundary,
        runtimeEvidenceKey: name,
        request: { action: name },
        response: name === "single-finish"
            ? { characterList: [], category9Evaluations: 2 }
            : { characterList: [] },
        dbBefore: { unlocks: [] },
        dbAfter: { unlocks: [] },
        characterSeeds: [...seedContract.characterSeeds],
        factSeeds: [...seedContract.factSeeds],
        directMissionSeeds: [...seedContract.directMissionSeeds],
        publicationObservation: {
            kind: "best-effort-context",
            explicitCharacterSeeds: [],
            characterListSeeds: [],
            contextCandidateCharacterSeeds: [...seedContract.characterSeeds],
            characterSeeds: [...seedContract.characterSeeds],
            factSeeds: [...seedContract.factSeeds],
            directMissionSeeds: [...seedContract.directMissionSeeds],
        },
        loaderCalls: [],
        missionComputes: 0,
        snapshotSource: "none",
        rereadReason: name === "single-finish"
            ? SINGLE_REREAD_REASON
            : "fresh owner state is loaded after the authoritative write",
        freshPostWriteEvaluationRequired: true,
        sqlReads: 1,
        sqlWrites: 0,
        sqlByTable: {
            players_character_awake_unlocks: { reads: 1, statements: 1, writes: 0 },
        },
    }
}

test("owner-focused contract fixes the required deterministic scenario set", () => {
    for (const required of [
        "single-finish",
        "multi-finish",
        "active-mission-receive",
        "box-gacha-exec",
        "character-town-grant",
        "learn-mana-final-node",
        "bond-success",
        "exchange-star-crumb",
        "gacha-exchange-character",
        "gacha-exec",
        "mana-item-sell",
        "mail-receive",
        "mail-receive-all",
        "category9-update-progress",
        "pass-card-receive-all",
        "raid-event-summary",
        "shop-buy",
        "shop-bulk-buy",
        "story-finish",
        "tutorial-step-15",
        "tutorial-step-16",
    ]) {
        assert.equal(AWAKE_OWNER_FOCUSED_SCENARIO_KEYS.includes(required), true, required)
    }
    assert.equal(AWAKE_OWNER_FOCUSED_SCENARIO_KEYS.length, 21)
    assert.equal(Object.keys(AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY).length, 21)
})

test("owner runtime evidence rejects seed-incompatible sharing", () => {
    const registry = {
        shared: {
            boundary: "best-effort-post-commit",
            owners: ["gacha/exec", "active_mission/receive"],
            scenarios: ["gacha-exec"],
            seedContract: {
                characterSeeds: [],
                factSeeds: [],
                directMissionSeeds: [],
            },
        },
    }
    const scenarios = {
        "gacha-exec": {
            owner: "gacha/exec",
            boundary: "best-effort-post-commit",
            runtimeEvidenceKey: "shared",
            characterSeeds: [],
            factSeeds: [],
            directMissionSeeds: [],
            publicationObservation: {
                characterSeeds: [],
                factSeeds: [],
                directMissionSeeds: [],
            },
        },
    }

    assert.throws(
        () => assertOwnerRuntimeEvidenceCoverage(registry, scenarios, [
            "gacha/exec",
            "active_mission/receive",
        ]),
        /active_mission\/receive.*runtime evidence/i,
    )
})

test("scenario declarations cannot replace runtime-observed publication seeds", () => {
    const registry = {
        "mail-receive": {
            boundary: "best-effort-in-tx",
            owners: ["mail/receive"],
            scenarios: ["mail-receive"],
            seedContract: {
                characterSeeds: [263002],
                factSeeds: ["player"],
                directMissionSeeds: [],
            },
        },
    }
    const scenarios = {
        "mail-receive": {
            owner: "mail/receive",
            boundary: "best-effort-in-tx",
            runtimeEvidenceKey: "mail-receive",
            characterSeeds: [263002],
            factSeeds: ["mail"],
            directMissionSeeds: [],
            publicationObservation: {
                characterSeeds: [263002],
                factSeeds: ["player"],
                directMissionSeeds: [],
            },
        },
    }

    assert.throws(
        () => assertOwnerRuntimeEvidenceCoverage(registry, scenarios, ["mail/receive"]),
        /declared.*observed.*fact/i,
    )
})

test("all matrix owners require owner-matched runtime observations", () => {
    const registry = structuredClone(AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY)
    const scenarioReports = Object.fromEntries(AWAKE_OWNER_FOCUSED_SCENARIO_KEYS.map(name => [
        name,
        {
            owner: "synthetic/unowned",
            boundary: "best-effort-post-commit",
            runtimeEvidenceKey: "missing",
            characterSeeds: [],
            factSeeds: [],
            directMissionSeeds: [],
            publicationObservation: {
                characterSeeds: [],
                factSeeds: [],
                directMissionSeeds: [],
            },
        },
    ]))

    assert.throws(
        () => assertOwnerRuntimeEvidenceCoverage(
            registry,
            scenarioReports,
            Object.values(registry).flatMap(entry => entry.owners),
        ),
        /owner-matched runtime evidence/i,
    )
})

test("admission rejects any behavior, seed, loader, compute, or per-table SQL drift", () => {
    const input = Object.fromEntries(AWAKE_OWNER_FOCUSED_SCENARIO_KEYS.map(key => [
        key,
        syntheticScenario(key),
    ]))
    const snapshot = createAwakeOwnerFocusedReport(input)
    for (const mutate of [
        report => { report.scenarios["exchange-star-crumb"].response.changed = true },
        report => { report.scenarios["exchange-star-crumb"].characterSeeds.push(1) },
        report => { report.scenarios["exchange-star-crumb"].loaderCalls.push("player") },
        report => { report.scenarios["exchange-star-crumb"].missionComputes++ },
        report => { report.scenarios["exchange-star-crumb"].dbAfter.unlocks.push([1, []]) },
        report => { report.scenarios["exchange-star-crumb"].sqlReads-- },
        report => { report.scenarios["exchange-star-crumb"].sqlByTable.players_character_awake_unlocks.reads++ },
        report => { report.scenarios["exchange-star-crumb"].publicationObservation.kind = "publish-wrapper" },
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
    const input = Object.fromEntries(AWAKE_OWNER_FOCUSED_SCENARIO_KEYS.map(key => [
        key,
        syntheticScenario(key),
    ]))
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

test("explicit write replaces a drifted checked snapshot", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "awake-owner-rewrite-"))
    const snapshotPath = path.join(directory, "snapshot.json")
    const input = Object.fromEntries(AWAKE_OWNER_FOCUSED_SCENARIO_KEYS.map(key => [
        key,
        syntheticScenario(key),
    ]))
    const original = createAwakeOwnerFocusedReport(input)
    try {
        assert.equal(admitAwakeOwnerFocusedReport(original, {
            snapshotPath,
            write: true,
        }).admitted, true)
        const changedInput = structuredClone(input)
        changedInput["exchange-star-crumb"].response.changed = true
        const changed = createAwakeOwnerFocusedReport(changedInput)

        assert.equal(admitAwakeOwnerFocusedReport(changed, { snapshotPath }).admitted, false)
        assert.equal(admitAwakeOwnerFocusedReport(changed, {
            snapshotPath,
            write: true,
        }).admitted, true)
        assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath, "utf8")), changed)
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
    assert.deepEqual(report.scenarios["single-finish"].directMissionSeeds, [])
    assert.equal(
        Object.hasOwn(
            AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY["single-finish"].seedContract,
            "runtimeNote",
        ),
        false,
    )
    assert.equal(report.scenarios["single-finish"].loaderCalls.length > 1, true)
    assert.deepEqual(report.scenarios["exchange-star-crumb"].characterSeeds, [])
    assert.deepEqual(report.scenarios["gacha-exchange-character"].characterSeeds, [151009])
    assert.deepEqual(report.scenarios["shop-bulk-buy"].characterSeeds, [341005, 341006])
    assert.deepEqual(report.scenarios["multi-finish"].factSeeds, [
        "collectedItems:100000", "items", "passState:3", "player",
    ])
    assert.deepEqual(report.scenarios["pass-card-receive-all"].dbAfter.player.totalManaObtained, 604800)
    assert.deepEqual(report.scenarios["raid-event-summary"].dbAfter.receivedUpTo, 1)
})
