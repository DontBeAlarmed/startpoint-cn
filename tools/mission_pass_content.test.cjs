const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mission-pass-content-"))
const sourceRoot = path.join(fixtureRoot, "source")
const sourceDirectory = path.join(sourceRoot, "orderedmap", "pass_card")
const outputDirectory = path.join(fixtureRoot, "output")
fs.mkdirSync(sourceDirectory, { recursive: true })

const previousSource = process.env.WF_ASSETS_CN_DIR
process.env.WF_ASSETS_CN_DIR = sourceRoot

const {
    TABLES,
    findPassCardSourceDirectory,
    generatePassMissionData,
} = require("../scripts/gen_pass_mission_data.js")

try {
    fs.writeFileSync(path.join(sourceRoot, "VERSION"), "1.4.54\n")
    for (const [index, sourceName] of Object.keys(TABLES).entries()) {
        fs.writeFileSync(
            path.join(sourceDirectory, sourceName),
            JSON.stringify({ [index + 1]: [[String(index + 1)]] }),
        )
    }

    assert.equal(findPassCardSourceDirectory(), sourceDirectory)
    generatePassMissionData(outputDirectory)
    for (const [index, outputName] of Object.values(TABLES).entries()) {
        const output = JSON.parse(fs.readFileSync(path.join(outputDirectory, outputName), "utf8"))
        assert.deepEqual(output, { [index + 1]: [[String(index + 1)]] })
    }

    process.env.WF_ASSETS_CN_DIR = path.join(sourceRoot, "orderedmap")
    assert.equal(findPassCardSourceDirectory(), sourceDirectory)
    generatePassMissionData(outputDirectory)
    process.env.WF_ASSETS_CN_DIR = sourceRoot

    fs.rmSync(path.join(sourceRoot, "VERSION"))
    assert.throws(
        () => generatePassMissionData(outputDirectory),
        /VERSION.*1\.4\.54/i,
        "缺少 VERSION 时必须拒绝生成",
    )

    fs.writeFileSync(path.join(sourceRoot, "VERSION"), "1.4.53\n")
    assert.throws(
        () => generatePassMissionData(outputDirectory),
        /VERSION.*1\.4\.54/i,
        "非官方 1.4.54 资源必须拒绝生成",
    )
} finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
    if (previousSource === undefined) delete process.env.WF_ASSETS_CN_DIR
    else process.env.WF_ASSETS_CN_DIR = previousSource
}

console.log("mission pass content tests passed")
