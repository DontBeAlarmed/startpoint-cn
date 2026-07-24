require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "..")
const generatorPath = path.join(projectRoot, "scripts", "gen_active_mission_data.js")
const activeMasterPath = path.join(projectRoot, "src", "lib", "mission", "active-master-data.ts")
assert.equal(fs.existsSync(generatorPath), true, "Active Mission 官方表生成器必须存在")
assert.equal(fs.existsSync(activeMasterPath), true, "Active Mission 运行时主数据读取器必须存在")

const {
    getActiveMissionEventMasterDefinitions,
    getActiveMissionMasterDefinitions,
} = require("../src/lib/mission/active-master-data")
assert.equal(getActiveMissionMasterDefinitions().length, 96)
assert.deepEqual(
    getActiveMissionEventMasterDefinitions().map(definition => definition.eventId).sort((a, b) => a - b),
    [1, 2, 3, 150],
)

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mission-active-content-"))
const sourceRoot = path.join(fixtureRoot, "source")
const sourceDirectory = path.join(sourceRoot, "orderedmap", "active_mission")
const outputDirectory = path.join(fixtureRoot, "output")
fs.mkdirSync(sourceDirectory, { recursive: true })

const previousSource = process.env.WF_ASSETS_CN_DIR
process.env.WF_ASSETS_CN_DIR = sourceRoot

const {
    TABLES,
    findActiveMissionSourceDirectory,
    generateActiveMissionData,
} = require(generatorPath)

try {
    fs.writeFileSync(path.join(sourceRoot, "VERSION"), "1.4.54\n")
    for (const [index, sourceName] of Object.keys(TABLES).entries()) {
        fs.writeFileSync(
            path.join(sourceDirectory, sourceName),
            JSON.stringify({ [index + 1]: [[String(index + 1)]] }),
        )
    }

    assert.equal(findActiveMissionSourceDirectory(), sourceDirectory)
    generateActiveMissionData(outputDirectory)
    for (const [index, outputName] of Object.values(TABLES).entries()) {
        const output = JSON.parse(fs.readFileSync(path.join(outputDirectory, outputName), "utf8"))
        assert.deepEqual(output, { [index + 1]: [[String(index + 1)]] })
    }

    process.env.WF_ASSETS_CN_DIR = path.join(sourceRoot, "orderedmap")
    assert.equal(findActiveMissionSourceDirectory(), sourceDirectory)
    generateActiveMissionData(outputDirectory)
    process.env.WF_ASSETS_CN_DIR = sourceRoot

    fs.rmSync(path.join(sourceRoot, "VERSION"))
    assert.throws(
        () => generateActiveMissionData(outputDirectory),
        /VERSION.*1\.4\.54/i,
        "缺少 VERSION 时必须拒绝生成",
    )
} finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
    if (previousSource === undefined) delete process.env.WF_ASSETS_CN_DIR
    else process.env.WF_ASSETS_CN_DIR = previousSource
}

console.log("mission active content tests passed")
