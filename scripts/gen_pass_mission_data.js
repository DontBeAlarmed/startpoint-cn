#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.resolve(__dirname, "..")
const SUPPORTED_WF_ASSETS_CN_VERSION = "1.4.54"

const TABLES = Object.freeze({
    "pass_card_daily_mission.json": "mission_pass_daily.json",
    "pass_card_daily_mission_reward.json": "mission_pass_daily_reward.json",
    "pass_card_week_mission.json": "mission_pass_week.json",
    "pass_card_week_mission_reward.json": "mission_pass_week_reward.json",
    "pass_card_event_mission.json": "mission_pass_event.json",
    "pass_card_event_mission_reward.json": "mission_pass_event_reward.json",
    "pass_card_event.json": "pass_card_event.json",
    "pass_card_reward.json": "pass_card_reward.json",
})

function orderedMapCandidates() {
    const candidates = []
    if (process.env.WF_ASSETS_CN_DIR) {
        const configured = path.resolve(process.env.WF_ASSETS_CN_DIR)
        candidates.push(configured)
        candidates.push(path.join(configured, "orderedmap"))
    }
    candidates.push(path.resolve(ROOT, "..", "wf-assets-cn", "orderedmap"))
    candidates.push(path.resolve(ROOT, "..", "..", "wf-assets-cn", "orderedmap"))
    return [...new Set(candidates)]
}

function findPassCardSourceDirectory() {
    for (const candidate of orderedMapCandidates()) {
        const directory = path.join(candidate, "pass_card")
        if (fs.existsSync(directory)) return directory
    }
    throw new Error(
        "找不到 wf-assets-cn/orderedmap/pass_card；请设置 WF_ASSETS_CN_DIR 指向 wf-assets-cn 或 orderedmap 目录。",
    )
}

function validateSourceVersion(sourceDirectory) {
    const sourceRoot = path.dirname(path.dirname(sourceDirectory))
    const versionPath = path.join(sourceRoot, "VERSION")
    let version
    try {
        version = fs.readFileSync(versionPath, "utf8").trim()
    } catch (error) {
        if (error?.code === "ENOENT") {
            throw new Error(`wf-assets-cn/VERSION 缺失；仅支持 ${SUPPORTED_WF_ASSETS_CN_VERSION}。`)
        }
        throw error
    }
    if (version !== SUPPORTED_WF_ASSETS_CN_VERSION) {
        throw new Error(
            `wf-assets-cn/VERSION 必须为 ${SUPPORTED_WF_ASSETS_CN_VERSION}，实际为 ${version || "空"}。`,
        )
    }
}

function generatePassMissionData(outputDirectory = path.join(ROOT, "assets")) {
    const sourceDirectory = findPassCardSourceDirectory()
    validateSourceVersion(sourceDirectory)
    fs.mkdirSync(outputDirectory, { recursive: true })

    for (const [sourceName, outputName] of Object.entries(TABLES)) {
        const sourcePath = path.join(sourceDirectory, sourceName)
        const outputPath = path.join(outputDirectory, outputName)
        const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8"))
        fs.writeFileSync(outputPath, `${JSON.stringify(parsed)}\n`)
        console.log(`${sourceName} -> ${path.relative(ROOT, outputPath)}`)
    }
}

if (require.main === module) generatePassMissionData()

module.exports = {
    TABLES,
    SUPPORTED_WF_ASSETS_CN_VERSION,
    findPassCardSourceDirectory,
    generatePassMissionData,
    orderedMapCandidates,
    validateSourceVersion,
}
