#!/usr/bin/env node
"use strict"

const { createHash } = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const SOURCE_COMMIT = "f8be41456f719a4bf39fab9072e00bebd09b8247"
const FIXTURE_PATH = path.join(
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

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: "utf8", ...options })
    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `${command} exited ${result.status}`)
    }
    return result.stdout
}

function parseProbe(output, prefix) {
    const line = output.split(/\r?\n/).find(candidate => candidate.startsWith(prefix))
    if (!line) throw new Error(`legacy probe did not emit ${prefix}`)
    return JSON.parse(line.slice(prefix.length))
}

function createComputeProbe(legacyRoot) {
    const sourcePath = path.join(legacyRoot, "tools", "mission_degree_progress.test.cjs")
    const source = fs.readFileSync(sourcePath, "utf8")
    const marker = "const levelAccount = insertAccountSync({"
    if (!source.includes(marker)) throw new Error("legacy Degree fixture marker is missing")
    const injection = `
const fixtureMissionIds = Object.keys(require("../assets/mission_degree.json")).map(Number)
const fixtureDbProgresses = [0, 2, 31, 1_000_000_000]
const fixtureHashes = Object.fromEntries(fixtureDbProgresses.map(dbProgress => {
    const values = fixtureMissionIds.map(missionId => [
        missionId,
        DegreeComputer.compute(missionId, context, dbProgress),
    ])
    return [String(dbProgress), require("node:crypto").createHash("sha256")
        .update(JSON.stringify(values)).digest("hex")]
}))
process.stdout.write("__DEGREE_COMPUTE__" + JSON.stringify({
    missionCount: fixtureMissionIds.length,
    dbProgresses: fixtureDbProgresses,
    hashes: fixtureHashes,
}) + "\\n")

`
    return source.replace(marker, `${injection}${marker}`)
}

const settlementProbe = `
"use strict"
require("ts-node/register/transpile-only")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "degree-legacy-fixture-"))
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
const { closeDatabase, initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { settleMissionCategories } = require("../src/lib/mission/settlement")
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
    const state = getPlayerCategoryMissionsSync(playerId, 5)[1000]
    return { missionId: 1000, progress: state.progress, stages: state.stages }
}
initializeDatabase()
try {
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "fixture",
        idpId: "degree-legacy-fixture-" + randomUUID(), status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    updatePlayerSync({ id: playerId, rankPoint: Number.MAX_SAFE_INTEGER })
    const scope = [{ category: 5, missionIds: [1000] }]
    const evaluationTime = new Date("2024-08-14T12:00:00.000Z")
    const firstResult = settleMissionCategories(playerId, scope, evaluationTime)
    const first = { response: response(firstResult), persisted: persisted(playerId) }
    const repeatedResult = settleMissionCategories(playerId, scope, evaluationTime)
    const repeated = { response: response(repeatedResult), persisted: persisted(playerId) }
    process.stdout.write("__DEGREE_SETTLEMENT__" + JSON.stringify({ first, repeated }) + "\\n")
} finally {
    closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
}
`

function runTemporaryProbe(legacyRoot, name, source, prefix) {
    const probePath = path.join(legacyRoot, "tools", `.${name}-${process.pid}.cjs`)
    fs.writeFileSync(probePath, source, "utf8")
    try {
        return parseProbe(run(process.execPath, [probePath], { cwd: legacyRoot }), prefix)
    } finally {
        fs.rmSync(probePath, { force: true })
    }
}

function parseArgs(args) {
    const write = args.includes("--write")
    const positional = args.filter(arg => arg !== "--write")
    if (positional.length !== 1) {
        throw new Error("usage: generate_mission_degree_legacy_fixture.cjs <f8be414-worktree> [--write]")
    }
    return { legacyRoot: path.resolve(positional[0]), write }
}

function main() {
    const { legacyRoot, write } = parseArgs(process.argv.slice(2))
    const commit = run("git", ["-C", legacyRoot, "rev-parse", "HEAD"]).trim()
    if (commit !== SOURCE_COMMIT) throw new Error(`expected ${SOURCE_COMMIT}, got ${commit}`)
    const compute = runTemporaryProbe(
        legacyRoot,
        "degree-compute-probe",
        createComputeProbe(legacyRoot),
        "__DEGREE_COMPUTE__",
    )
    const settlement = runTemporaryProbe(
        legacyRoot,
        "degree-settlement-probe",
        settlementProbe,
        "__DEGREE_SETTLEMENT__",
    )
    const payload = {
        schemaVersion: 1,
        source: {
            commit: SOURCE_COMMIT,
            version: "pre-5B",
            entrypoint: "src/lib/mission/computer-degree.ts",
            generator: "tools/generate_mission_degree_legacy_fixture.cjs",
        },
        compute,
        settlement,
    }
    const fixture = {
        ...payload,
        integritySha256: createHash("sha256")
            .update(JSON.stringify(sorted(payload)))
            .digest("hex"),
    }
    const serialized = `${JSON.stringify(fixture, null, 2)}\n`
    if (write) fs.writeFileSync(FIXTURE_PATH, serialized, "utf8")
    process.stdout.write(serialized)
}

try {
    main()
} catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`)
    process.exitCode = 1
}
