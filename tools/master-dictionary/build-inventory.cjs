#!/usr/bin/env node
"use strict"

// 主清单构建：boot_ffc6.as 的 path→Table 类映射 × generated 的 Values/Table 配对
// × 三层数据源（wf-assets-cn 视图 / 服务端 bundle）对照 → inventory.json。
// 权威性说明：路径映射来自客户端启动装配（boot_ffc6.as MasterSource 表），
// 列语义来自 generated/*Values.as（由 generate.cjs 解析，本清单只登记配对关系）。

const fs = require("node:fs")
const path = require("node:path")

const PROJECT_ROOT = path.resolve(__dirname, "../..")
const CLIENT_ROOT = path.resolve(PROJECT_ROOT, "../wf-cn-client-as3-20261014")
const BOOT = path.join(CLIENT_ROOT, "scripts/boot_ffc6.as")
const GENERATED = path.join(CLIENT_ROOT, "scripts/pinball/master/generated")
const ASSETS_CN = path.resolve(PROJECT_ROOT, "../wf-assets-cn/orderedmap")

function toSnakeCase(value) {
    return value
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .toLowerCase()
}

function main() {
    const boot = fs.readFileSync(BOOT, "utf8")
    const pairRegex = /"path"\s*:\s*"([^"]+)"\s*,\s*[^{}]*?"clazz"\s*:\s*([A-Za-z0-9_]+)/g
    const classToPaths = new Map()
    for (const [, rawPath, clazz] of boot.matchAll(pairRegex)) {
        const tableClass = clazz.endsWith("Table") ? clazz : `${clazz}Table`
        if (!classToPaths.has(tableClass)) classToPaths.set(tableClass, [])
        classToPaths.get(tableClass).push(rawPath)
    }

    const generatedFiles = fs.readdirSync(GENERATED)
    const valuesClasses = generatedFiles.filter(name => name.endsWith("Values.as"))

    const entries = []
    const unresolved = []
    for (const file of valuesClasses) {
        const className = file.slice(0, -"Values.as".length)
        const tableClass = `${className}Table`
        const tableName = toSnakeCase(className)
        const paths = classToPaths.get(tableClass)
        if (paths === undefined) {
            unresolved.push({ className, tableName, reason: "no boot path mapping" })
            continue
        }
        const sources = paths.map(rawPath => {
            const relative = rawPath.replace(/^\//, "")
            const cnPath = path.join(ASSETS_CN, `${relative}.json`)
            let cnStatus = "missing"
            try {
                const stat = fs.statSync(cnPath)
                cnStatus = stat.size <= 8 ? "empty-stub" : "decoded"
            } catch { /* missing */ }
            return {
                logicalPath: `master/${relative}.orderedmap`,
                wfAssetsCn: `orderedmap/${relative}.json`,
                wfAssetsCnStatus: cnStatus,
            }
        })
        const primary = sources[0]
        const bundlePath = path.join(PROJECT_ROOT, "assets", `${tableName}.json`)
        let bundle = null
        if (fs.existsSync(bundlePath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(bundlePath, "utf8"))
                bundle = { present: true, topKeys: Object.keys(parsed).length }
            } catch {
                bundle = { present: true, topKeys: -1, note: "unparseable" }
            }
        }
        entries.push({
            tableName,
            valuesClass: `scripts/pinball/master/generated/${file}`,
            tableClass: `scripts/pinball/master/generated/${tableClass}.as`,
            domain: primary.logicalPath.split("/")[1] ?? "root",
            sources,
            serverBundle: bundle ?? { present: false },
        })
    }

    const inventory = {
        version: 1,
        generatedAt: new Date().toISOString(),
        clientRoot: "../wf-cn-client-as3-20261014",
        counts: {
            valuesClasses: valuesClasses.length,
            entries: entries.length,
            unresolved: unresolved.length,
            withServerBundle: entries.filter(e => e.serverBundle.present).length,
            withDecodedCnView: entries.filter(e => e.sources.some(s => s.wfAssetsCnStatus === "decoded")).length,
        },
        entries,
        unresolved,
    }
    const outPath = path.join(__dirname, "inventory.json")
    fs.writeFileSync(outPath, `${JSON.stringify(inventory, null, 4)}\n`)
    process.stdout.write(
        `inventory: ${entries.length}/${valuesClasses.length} tables, `
        + `${inventory.counts.withServerBundle} with server bundle, `
        + `${inventory.counts.withDecodedCnView} with decoded CN view, `
        + `${unresolved.length} unresolved\n`,
    )
}

main()
