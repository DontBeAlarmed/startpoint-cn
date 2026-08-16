#!/usr/bin/env node
"use strict"

const { spawnSync } = require("node:child_process")
const { createHash } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const SOURCE_COMMIT = "d594854070718d12c3dab4a31901d5647c4bf1e9"
const ROOT = path.resolve(__dirname, "..")
const FIXTURE_PATH = path.join(
    __dirname,
    "fixtures",
    "mission-event",
    "legacy-d594854.json",
)

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? ROOT,
        encoding: "utf8",
        env: options.env ?? process.env,
        maxBuffer: 64 * 1024 * 1024,
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout}`)
    }
    return result.stdout
}

function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted)
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
}

function probeSource() {
    return `
"use strict"
require("ts-node/register/transpile-only")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "event-legacy-fixture-"))
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
const { closeDatabase, initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { givePlayerItemSync } = require("../src/data/domains/item")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { EventSafeComputer } = require("../src/lib/mission/computer-event-safe")
const { settleMissionCategories } = require("../src/lib/mission/settlement")

function context(extra = {}) {
    return {
        category: 3,
        playerId: 1,
        player: {},
        questProgress: {},
        totalQuestClears: 0,
        totalStories: 0,
        rankCounts: {},
        eventMissionProgress: new Map(),
        ...extra,
    }
}

const finishedQuest = {
    questId: 1001,
    finished: true,
    clearRank: 5,
    bestElapsedTimeMs: 10_000,
    leaderCharacterId: undefined,
    multiClearCount: undefined,
}
const currentStateMissionIds = [
    1201, 1202, 1203, 1204, 1205, 1206, 1207, 1212,
    1217, 1218, 1219, 1220, 1305, 1306, 1307,
]
const availableCurrentState = {
    maxCharacterLevel: 65,
    manaBoardNodeCount: 15,
    overLimitCount: 2,
    characterEpisodeClearCount: 4,
    clearedMainChapters: new Set([1, 3]),
    equipmentAwakeningCount: 3,
    hasEquippedAbilitySoul: true,
}
const unavailableCurrentState = {
    maxCharacterLevel: null,
    manaBoardNodeCount: null,
    overLimitCount: null,
    characterEpisodeClearCount: null,
    clearedMainChapters: null,
    equipmentAwakeningCount: null,
    hasEquippedAbilitySoul: null,
}
function computeCurrentState(state, dbProgress) {
    return Object.fromEntries(currentStateMissionIds.map(missionId => [
        missionId,
        EventSafeComputer.compute(missionId, context({ eventCurrentState: state }), dbProgress),
    ]))
}
const compute = {
    currentState: {
        available: computeCurrentState(availableCurrentState, 0),
        unavailable: computeCurrentState(unavailableCurrentState, 7),
    },
    item: EventSafeComputer.compute(2316, context({ collectedItemTotals: { 80111: 12 } }), 3),
    quest: EventSafeComputer.compute(1303, context({ questProgress: { 13: [finishedQuest] } }), 0),
    aggregate: EventSafeComputer.compute(1454, context({
        questProgress: { 13: [{ ...finishedQuest, questId: 1002 }] },
        eventMissionProgress: new Map([[1448, 1]]),
    }), 0),
    persisted: EventSafeComputer.compute(1200, context(), 7),
    unsupported: EventSafeComputer.compute(1402, context(), 9),
}

function response(result) {
    return {
        missionInfo: result.missionInfo,
        itemList: result.itemList,
        characterList: result.characterList,
        equipmentList: result.equipmentList,
        degreeIds: result.degreeIds,
        passCardPoints: result.passCardPoints,
        userInfo: result.userInfo ?? null,
    }
}

function persisted(playerId) {
    const state = getPlayerCategoryMissionsSync(playerId, 3)[2316]
    return { missionId: 2316, progress: state.progress, stages: state.stages }
}

initializeDatabase()
try {
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "fixture",
        idpId: "event-legacy-fixture-" + randomUUID(), status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    givePlayerItemSync(playerId, 80111, 10)
    const scope = [{ category: 3, missionIds: [2316] }]
    const evaluationTime = new Date("2023-11-30T04:00:00.000Z")
    const firstResult = settleMissionCategories(playerId, scope, evaluationTime)
    const first = { response: response(firstResult), persisted: persisted(playerId) }
    const repeatedResult = settleMissionCategories(playerId, scope, evaluationTime)
    const repeated = { response: response(repeatedResult), persisted: persisted(playerId) }
    process.stdout.write("__EVENT_FIXTURE__" + JSON.stringify({ compute, settlement: { first, repeated } }) + "\\n")
} finally {
    closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
}
`
}

function parseProbe(output) {
    const marker = "__EVENT_FIXTURE__"
    const line = output.split(/\r?\n/).find(entry => entry.startsWith(marker))
    if (!line) throw new Error(`legacy Event probe marker missing\n${output}`)
    return JSON.parse(line.slice(marker.length))
}

function extractLegacySource(directory) {
    const archivePath = path.join(directory, "source.tar")
    run("git", ["archive", "--format=tar", `--output=${archivePath}`, SOURCE_COMMIT])
    const legacyRoot = path.join(directory, "source")
    fs.mkdirSync(legacyRoot)
    run("tar", ["-xf", archivePath, "-C", legacyRoot])
    // The fixture isolates source at d594854 while intentionally reusing the installed test toolchain.
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(legacyRoot, "node_modules"), "dir")
    return legacyRoot
}

function main() {
    const write = process.argv.slice(2).includes("--write")
    const resolved = run("git", ["rev-parse", `${SOURCE_COMMIT}^{commit}`]).trim()
    if (resolved !== SOURCE_COMMIT) throw new Error(`expected ${SOURCE_COMMIT}, got ${resolved}`)

    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "event-legacy-source-"))
    try {
        const legacyRoot = extractLegacySource(temporaryDirectory)
        const probePath = path.join(legacyRoot, "tools", `.event-legacy-probe-${process.pid}.cjs`)
        fs.writeFileSync(probePath, probeSource(), "utf8")
        const result = parseProbe(run(process.execPath, [probePath], { cwd: legacyRoot }))
        const payload = {
            schemaVersion: 1,
            source: {
                commit: SOURCE_COMMIT,
                version: "pre-event-session",
                entrypoint: "src/lib/mission/computer-event-safe.ts",
                generator: "tools/generate_mission_event_legacy_fixture.cjs",
            },
            ...result,
        }
        const fixture = {
            ...payload,
            integritySha256: createHash("sha256")
                .update(JSON.stringify(sorted(payload)))
                .digest("hex"),
        }
        const serialized = `${JSON.stringify(fixture, null, 2)}\n`
        if (write) {
            fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true })
            fs.writeFileSync(FIXTURE_PATH, serialized, "utf8")
        }
        process.stdout.write(serialized)
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    }
}

try {
    main()
} catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`)
    process.exitCode = 1
}
