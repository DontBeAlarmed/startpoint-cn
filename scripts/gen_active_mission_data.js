#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.resolve(__dirname, "..")
const SUPPORTED_WF_ASSETS_CN_VERSION = "1.4.54"

const TABLES = Object.freeze({
    "active_mission.json": "mission_active.json",
    "active_mission_event.json": "mission_active_event.json",
    "active_mission_reward.json": "mission_active_reward.json",
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

function findActiveMissionSourceDirectory() {
    for (const candidate of orderedMapCandidates()) {
        const directory = path.join(candidate, "active_mission")
        if (fs.existsSync(directory)) return directory
    }
    throw new Error(
        "找不到 wf-assets-cn/orderedmap/active_mission；请设置 WF_ASSETS_CN_DIR 指向 wf-assets-cn 或 orderedmap 目录。",
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

function generateActiveMissionData(outputDirectory = path.join(ROOT, "assets")) {
    const sourceDirectory = findActiveMissionSourceDirectory()
    validateSourceVersion(sourceDirectory)
    fs.mkdirSync(outputDirectory, { recursive: true })

    for (const [sourceName, outputName] of Object.entries(TABLES)) {
        const sourcePath = path.join(sourceDirectory, sourceName)
        const outputPath = path.join(outputDirectory, outputName)
        const source = fs.readFileSync(sourcePath, "utf8")
        JSON.parse(source)
        fs.writeFileSync(outputPath, `${source.trimEnd()}\n`)
        console.log(`${sourceName} -> ${path.relative(ROOT, outputPath)}`)
    }
}

if (require.main === module) generateActiveMissionData()

module.exports = {
    TABLES,
    findActiveMissionSourceDirectory,
    generateActiveMissionData,
    orderedMapCandidates,
    validateSourceVersion,
}
