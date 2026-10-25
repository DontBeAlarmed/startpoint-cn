#!/usr/bin/env node
"use strict"

// 全表列语义字典生成器：解析客户端 generated/*Values.as 构造器的逐列解析表达式，
// 结合 wf-assets-cn 解码视图的逐列抽样统计与服务端 bundle 字段对照，产出
// docs/master-dictionary/<tableName>.json。确定性输出（无时间戳/无路径绝对值），
// 重跑幂等。解析不出的构造形态如实标 unparsed-fragment，不猜。

const fs = require("node:fs")
const path = require("node:path")

const PROJECT_ROOT = path.resolve(__dirname, "../..")
const CLIENT_ROOT = path.resolve(PROJECT_ROOT, "../wf-cn-client-as3-20261014")
const GENERATED = path.join(CLIENT_ROOT, "scripts/pinball/master/generated")
const ASSETS_CN = path.resolve(PROJECT_ROOT, "../wf-assets-cn/orderedmap")
const DOCS_DIR = path.join(PROJECT_ROOT, "docs/master-dictionary")
const SERVER_SRC_ROOT = path.join(PROJECT_ROOT, "src")

const MAX_SAMPLE_ROWS = 2000

// ---------- Values.as 解析 ----------

function toCamelCase(snake) {
    return snake.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase())
}

function parseValuesClass(filePath) {
    const source = fs.readFileSync(filePath, "utf8")
    const lines = source.split("\n")

    const declarations = []
    for (let i = 0; i < lines.length; i++) {
        const match = /^(\s*)public var ([A-Za-z0-9_]+)(?::([A-Za-z0-9_.<>]+))?;/.exec(lines[i])
        if (match) {
            declarations.push({ name: match[2], as3Type: match[3] ?? null, line: i + 1 })
        }
    }

    const constructorStart = lines.findIndex(line => line.includes("public function "))
    const body = lines.slice(constructorStart).join("\n")

    // 客户端读取的最高列号（param1[N] 全集）
    const columnIndexHits = [...body.matchAll(/param1\[(\d+)\]/g)].map(m => Number(m[1]))
    const clientMaxColumn = columnIndexHits.length > 0 ? Math.max(...columnIndexHits) : -1

    const columns = []
    for (const declaration of declarations) {
        const { name } = declaration
        // 直接列绑定：name = <expr involving param1[N]>
        const direct = new RegExp(
            `${name} = ([^;]{0,220}param1\\[(\\d+)\\][^;]{0,220});`,
        ).exec(body)
        // Option 单列：_locX_ = param1[N]; ... name = _locX_ == "(None)" ? ...（间接）
        let index = null
        let rule = null
        if (direct) {
            index = Number(direct[2])
            rule = classifyExpression(direct[1])
        } else {
            // 间接绑定：定位对 name 的赋值表达式（含 _locN_ 局部），再追该局部
            // 最近的 param1 来源——局部变量在构造器中被复用，必须取字段赋值
            // 位置**之前**最近的一次（haxe 生成代码同名局部串用）
            const assign = new RegExp(`${name} = ([^;]{0,400});`).exec(body)
            if (assign) {
                rule = classifyExpression(assign[1])
                const localMatch = /(_loc\d+_)/.exec(assign[1])
                if (localMatch) {
                    const local = localMatch[1]
                    const assignPos = body.indexOf(assign[0])
                    const before = body.slice(0, assignPos)
                    const localDefs = [...before.matchAll(
                        new RegExp(`${local}\\s*(:[A-Za-z]+)?\\s*=[^;]{0,100}?param1\\[(\\d+)\\]`, 'g'),
                    )]
                    if (localDefs.length > 0) index = Number(localDefs[localDefs.length - 1][2])
                    rule = rule ?? "composite"
                }
            }
        }
        if (index === null) {
            // 枚举判别列（if(_locX_ == "2") … Kind.BossBattle(param1[13],…) 形态）：
            // 列号取该字段赋值块内出现的最小 param1 索引
            const block = findAssignmentBlock(body, name)
            if (block !== null) {
                const hits = [...block.matchAll(/param1\[(\d+)\]/g)].map(m => Number(m[1]))
                if (hits.length > 0) index = Math.min(...hits)
                rule = rule ?? "enum-ref-or-composite"
            }
        }
        columns.push({
            name,
            as3Type: declaration.as3Type,
            line: declaration.line,
            index,
            parseRule: rule ?? (index === null ? "unparsed-fragment" : "composite"),
        })
    }

    const enumRefs = [...new Set([...body.matchAll(/QuestReferenceIdKind|([A-Za-z]+Kind)\./g)]
        .map(m => m[1]).filter(Boolean))]
    return { columns, clientMaxColumn, enumRefs, raw: { classLines: lines.length } }
}

function classifyExpression(expr) {
    if (expr.includes("Option.None") || expr.includes("Option.Some")) {
        if (expr.includes("parseInt")) return "option-int"
        if (expr.includes("parseFloat")) return "option-float"
        if (expr.includes(".split(")) return "option-array"
        return "option-string"
    }
    if (expr.includes("Std.parseFloat")) return "float"
    if (expr.includes("Std.parseInt") || /\bint\(/.test(expr)) return "int"
    if (expr.includes(".split(")) return "array"
    if (expr.includes('== "true"') || expr.includes('== "false"')) return "bool"
    if (/^param1\[\d+\]$/.test(expr.trim())) return "string"
    if (/param1\[\d+\]/.test(expr)) return "composite"
    return null
}

function findAssignmentBlock(body, fieldName) {
    // 粗粒度：从 "fieldName = " 或 "var … fieldName" 起，截到下一个 public var / return
    const start = body.indexOf(`${fieldName} = `)
    if (start === -1) return null
    const next = body.indexOf("public var", start)
    return body.slice(start, next === -1 ? start + 4000 : next)
}

// ---------- wf-assets-cn 抽样 ----------

function collectRows(node, depth, expectedDepth, rows) {
    if (Array.isArray(node)) {
        if (depth === expectedDepth) {
            for (const row of node) {
                if (Array.isArray(row)) rows.push(row)
            }
        } else if (depth < expectedDepth + 2) {
            for (const row of node) collectRows(row, depth + 1, expectedDepth, rows)
        }
        return
    }
    if (node !== null && typeof node === "object") {
        for (const value of Object.values(node)) collectRows(value, depth + 1, expectedDepth, rows)
    }
}

function sampleColumns(source, nestingDepth) {
    if (source.wfAssetsCnStatus !== "decoded") return null
    let parsed
    try {
        parsed = JSON.parse(fs.readFileSync(path.join(ASSETS_CN, source.wfAssetsCn.replace(/^orderedmap\//, "")), "utf8"))
    } catch {
        return null
    }
    const rows = []
    collectRows(parsed, 0, nestingDepth, rows)
    if (rows.length === 0) return null
    const sample = rows.slice(0, MAX_SAMPLE_ROWS)
    const width = Math.max(...sample.map(row => row.length))
    const stats = []
    for (let i = 0; i < width; i++) {
        let present = 0
        let noneMarker = 0
        const intValues = { min: null, max: null }
        const distinct = new Set()
        for (const row of sample) {
            const value = row[i]
            if (value === undefined) continue
            present++
            const text = String(value)
            if (text === "(None)" || text === "") noneMarker++
            distinct.add(text)
            const numeric = Number(text)
            if (text !== "" && Number.isFinite(numeric)) {
                if (intValues.min === null || numeric < intValues.min) intValues.min = numeric
                if (intValues.max === null || numeric > intValues.max) intValues.max = numeric
            }
        }
        stats.push({
            index: i,
            sampledRows: sample.length,
            present,
            noneOrEmpty: noneMarker,
            alwaysEmpty: present > 0 && noneMarker === present,
            distinctCount: distinct.size,
            ...(intValues.min !== null ? { intMin: intValues.min, intMax: intValues.max } : {}),
        })
    }
    return { rowsTotal: rows.length, rowsSampled: sample.length, width, stats }
}

// ---------- 服务端对照 ----------

function collectBundleKeys(value, keys, depth = 0) {
    if (depth > 6 || value === null || typeof value !== "object") return
    if (Array.isArray(value)) {
        for (const item of value) collectBundleKeys(item, keys, depth + 1)
        return
    }
    for (const [key, child] of Object.entries(value)) {
        keys.add(key)
        collectBundleKeys(child, keys, depth + 1)
    }
}

function serverConsumers(tableName) {
    // 只扫描 src/ 的表名引用（浅扫描，一次性）
    return SERVER_CONSUMERS.get(tableName) ?? []
}

const SERVER_CONSUMERS = new Map()
function buildServerConsumerIndex() {
    const queue = [SERVER_SRC_ROOT]
    const needle = `.json`
    while (queue.length > 0) {
        const dir = queue.shift()
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) { queue.push(full); continue }
            if (!entry.name.endsWith(".ts")) continue
            const source = fs.readFileSync(full, "utf8")
            for (const match of source.matchAll(/"([a-z0-9_]+\.json)"/g)) {
                const table = match[1]
                if (!SERVER_CONSUMERS.has(table)) SERVER_CONSUMERS.set(table, [])
                SERVER_CONSUMERS.get(table).push(path.relative(PROJECT_ROOT, full).split(path.sep).join("/"))
            }
            void needle
        }
    }
    for (const [table, files] of SERVER_CONSUMERS) {
        SERVER_CONSUMERS.set(table, [...new Set(files)].sort())
    }
}

// ---------- 主流程 ----------

function buildEntry(inventoryEntry) {
    const valuesPath = path.join(CLIENT_ROOT, inventoryEntry.valuesClass)
    const parsed = parseValuesClass(valuesPath)

    const primary = inventoryEntry.sources[0]
    const nestingDepth = inferNestingDepth(primary.logicalPath, inventoryEntry.tableName)
    const sampling = sampleColumns(primary, nestingDepth)

    let bundleKeys = null
    if (inventoryEntry.serverBundle.present) {
        const keys = new Set()
        try {
            collectBundleKeys(JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "assets", `${inventoryEntry.tableName}.json`), "utf8")), keys)
            bundleKeys = keys
        } catch { bundleKeys = null }
    }
    const consumers = serverConsumers(`${inventoryEntry.tableName}.json`)

    const columns = parsed.columns.map(column => {
        const stat = sampling?.stats.find(s => s.index === column.index) ?? null
        const camel = toCamelCase(column.name)
        const serverUsed = bundleKeys !== null
            && (bundleKeys.has(column.name) || bundleKeys.has(camel))
        let status
        if (column.index === null || column.index > parsed.clientMaxColumn) {
            status = column.index === null && column.parseRule === "unparsed-fragment"
                ? "unparsed-fragment"
                : "unknown-semantics"
        } else if (stat?.alwaysEmpty) {
            status = "always-empty"
        } else if (serverUsed) {
            status = "server-used"
        } else {
            status = "client-only"
        }
        return {
            index: column.index,
            name: column.name,
            as3Type: column.as3Type,
            parseRule: column.parseRule,
            status,
            ...(stat !== null ? { sample: {
                distinctCount: stat.distinctCount,
                noneOrEmpty: stat.noneOrEmpty,
                ...(stat.intMin !== undefined ? { intMin: stat.intMin, intMax: stat.intMax } : {}),
            } } : {}),
        }
    })

    return {
        version: 1,
        table: inventoryEntry.tableName,
        domain: inventoryEntry.domain,
        authority: {
            valuesClass: `../wf-cn-client-as3-20261014/${inventoryEntry.valuesClass}`,
            clientMaxColumn: parsed.clientMaxColumn,
            dataRows: sampling?.rowsTotal ?? null,
        },
        sources: inventoryEntry.sources.map(source => ({
            logicalPath: source.logicalPath,
            wfAssetsCnStatus: source.wfAssetsCnStatus,
        })),
        serverBundle: inventoryEntry.serverBundle.present
            ? { present: true, consumers }
            : { present: false },
        enumRefs: parsed.enumRefs,
        columns,
    }
}

const NESTING_OVERRIDES = new Map([
    ["boss_battle_quest", 3], ["main_quest", 3], ["ex_quest", 3],
    ["character_quest", 1],
])

function inferNestingDepth(logicalPath, tableName) {
    if (NESTING_OVERRIDES.has(tableName)) return NESTING_OVERRIDES.get(tableName)
    void logicalPath
    return 2
}

function main() {
    buildServerConsumerIndex()
    const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, "inventory.json"), "utf8"))
    fs.mkdirSync(DOCS_DIR, { recursive: true })

    const domains = new Map()
    for (const entry of inventory.entries) {
        try {
            const dictionary = buildEntry(entry)
            const outPath = path.join(DOCS_DIR, `${entry.tableName}.json`)
            fs.writeFileSync(outPath, `${JSON.stringify(dictionary, null, 2)}\n`)
            if (!domains.has(entry.domain)) domains.set(entry.domain, [])
            domains.get(entry.domain).push(entry.tableName)
        } catch (error) {
            process.stderr.write(`FAIL ${entry.tableName}: ${error.message}\n`)
        }
    }
    const summary = [...domains.entries()]
        .map(([domain, tables]) => `${domain}:${tables.length}`)
        .join(" ")
    process.stdout.write(`generated ${[...domains.values()].reduce((n, t) => n + t.length, 0)} dictionaries\n${summary}\n`)
}

main()
