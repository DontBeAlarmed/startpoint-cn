"use strict"

// server-scope 门控回归：config.json 这类仓库源文件的内容变化必须触发
// 重新同步（reason "server-source"），不再被版本门控永久跳过。
// 背景（2026-10-05）：max_star_crumb 改了 assets/config.json 后 sync 仍报
// synchronized，运行时继续读旧值导致邮箱星碎片领取不进包。

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    createSummary,
    decideReason,
    patchSourceDigest,
    serverSourceDigest,
} = require("../src/content/sync/engine")

const projectRoot = path.resolve(__dirname, "..")

const scan = {
    targetVersion: "1.4.54",
    patchManifests: [],
    archives: [],
    ignoredPaths: [],
    entityListsRelativePath: "EntityLists/PathFile",
}

const gameCalendar = { utcOffsetMinutes: 480 }
const generatorVersion = 1

const serverDefinitions = [
    { tableName: "config.json", scope: "server", bundledPath: "assets/config.json" },
    {
        tableName: "payment_products.json",
        scope: "server",
        bundledPath: "assets/payment_products.json",
    },
]

function currentRelease(summary) {
    return {
        manifest: {
            assetVersion: "1.4.54",
            generatorVersion,
            gameCalendarUtcOffsetMinutes: gameCalendar.utcOffsetMinutes,
        },
        summary,
    }
}

test("server 源文件摘要对相同输入稳定、不同输入可区分", () => {
    const digest = serverSourceDigest(projectRoot, serverDefinitions)
    assert.match(digest, /^sha256:[a-f0-9]{64}$/)
    assert.equal(serverSourceDigest(projectRoot, serverDefinitions), digest)

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "server-source-gate-"))
    t_after(scratch)
    const alteredRoot = path.join(scratch, "project", "assets")
    fs.mkdirSync(alteredRoot, { recursive: true })
    for (const definition of serverDefinitions) {
        fs.copyFileSync(
            path.join(projectRoot, definition.bundledPath),
            path.join(alteredRoot, path.basename(definition.bundledPath)),
        )
    }
    fs.writeFileSync(path.join(alteredRoot, "config.json"), '{"max_star_crumb": 99999}')
    const altered = serverSourceDigest(scratch + "/project", serverDefinitions)
    assert.notEqual(altered, digest)
})

function t_after(scratch) {
    process.once("exit", () => fs.rmSync(scratch, { recursive: true, force: true }))
}

test("旧 release 摘要缺少 serverSourceDigest 时必须判定 server-source", () => {
    const legacySummary = {
        patchSourceDigest: patchSourceDigest(scan),
    }
    assert.equal(
        decideReason(
            "sync",
            scan,
            currentRelease(legacySummary),
            generatorVersion,
            gameCalendar,
            projectRoot,
            serverDefinitions,
        ),
        "server-source",
        "版本门控时代的旧摘要没有 server 源摘要，必须触发一次重同步",
    )
})

test("摘要一致且其余检查通过时才判定 up-to-date", () => {
    const digest = serverSourceDigest(projectRoot, serverDefinitions)
    const summary = createSummary(scan, {}, generatorVersion, 2, digest)
    assert.equal(summary.serverSourceDigest, digest)
    const registryDefinitions = serverDefinitions.map(definition => ({
        ...definition,
        converterId: "server-json",
        converterVersion: 1,
        manifestSources: [definition.bundledPath],
    }))
    const tables = Object.fromEntries(registryDefinitions.map(definition => [
        definition.tableName,
        {
            scope: definition.scope,
            converterId: "server-json",
            converterVersion: 1,
            sources: definition.manifestSources,
        },
    ]))
    const release = currentRelease(summary)
    release.manifest.tables = tables
    const reason = decideReason(
        "sync",
        scan,
        release,
        generatorVersion,
        gameCalendar,
        projectRoot,
        registryDefinitions,
    )
    assert.equal(reason, "up-to-date")
})
