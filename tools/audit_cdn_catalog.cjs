#!/usr/bin/env node
"use strict"

require("ts-node/register/transpile-only")

const path = require("node:path")

const { resolveContentPaths } = require("../src/content/paths")
const {
    buildCdnCatalog,
    CatalogValidationError,
    scanCdnCatalogInput,
} = require("../src/content/cdn/catalog-builder")
const { createCdnAuditReport } = require("../src/content/cdn/audit")
const { CdnPlannerError, planCdnUpdate } = require("../src/content/cdn/planner")

const PROJECT_ROOT = path.resolve(__dirname, "..")
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const VALUE_OPTIONS = new Map([
    ["--current", "currentVersion"],
    ["--target", "targetVersion"],
    ["--platform", "platform"],
    ["--asset-size", "assetSize"],
    ["--cdn-dir", "CDN_DIR"],
    ["--content-state-dir", "CONTENT_STATE_DIR"],
    ["--content-store-dir", "CONTENT_STORE_DIR"],
    ["--content-runtime-dir", "CONTENT_RUNTIME_DIR"],
])

class AuditCliError extends Error {
    constructor(code, message) {
        super(message)
        this.name = "AuditCliError"
        this.code = code
    }
}

function isValidVersion(value) {
    const match = VERSION_PATTERN.exec(value)
    return match !== null && match.slice(1).every(component => Number.isSafeInteger(Number(component)))
}

function parseArguments(argv) {
    const output = {
        json: false,
        isInitial: false,
        currentVersion: null,
        targetVersion: null,
        platform: "android",
        assetSize: "fulfill",
        pathOverrides: {},
    }
    const seen = new Set()

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        if (argument === "--json" || argument === "--initial") {
            if (seen.has(argument)) {
                throw new AuditCliError("AUDIT_DUPLICATE_ARGUMENT", `参数 ${argument} 不能重复`)
            }
            seen.add(argument)
            if (argument === "--json") output.json = true
            else output.isInitial = true
            continue
        }

        const property = VALUE_OPTIONS.get(argument)
        if (!property) {
            throw new AuditCliError("AUDIT_UNKNOWN_ARGUMENT", "存在未知参数")
        }
        if (seen.has(argument)) {
            throw new AuditCliError("AUDIT_DUPLICATE_ARGUMENT", `参数 ${argument} 不能重复`)
        }
        seen.add(argument)
        const value = argv[index + 1]
        if (value === undefined || value.startsWith("--")) {
            throw new AuditCliError("AUDIT_MISSING_ARGUMENT_VALUE", `参数 ${argument} 缺少值`)
        }
        index++
        if (property === "currentVersion" || property === "targetVersion") {
            output[property] = value
        } else if (property === "platform" || property === "assetSize") {
            output[property] = value.toLowerCase()
        } else {
            output.pathOverrides[property] = value
        }
    }

    if (output.currentVersion !== null && !isValidVersion(output.currentVersion)) {
        throw new AuditCliError("AUDIT_INVALID_VERSION", "current 必须是规范的三段数字版本")
    }
    if (output.targetVersion !== null && !isValidVersion(output.targetVersion)) {
        throw new AuditCliError("AUDIT_INVALID_VERSION", "target 必须是规范的三段数字版本")
    }
    if (output.platform !== "android") {
        throw new AuditCliError("UNSUPPORTED_PLATFORM", "阶段 1 只支持 android")
    }
    if (!["fulfill", "shortened", "delayed"].includes(output.assetSize)) {
        throw new AuditCliError(
            "UNSUPPORTED_ASSET_SIZE_KIND",
            "asset-size 必须是 fulfill、shortened 或 delayed",
        )
    }
    if (output.isInitial && output.currentVersion !== null) {
        throw new AuditCliError(
            "AUDIT_INITIAL_CURRENT_CONFLICT",
            "--initial 不能与 --current 同时使用",
        )
    }
    if (!output.isInitial && output.currentVersion === null) {
        throw new AuditCliError("AUDIT_CURRENT_REQUIRED", "非初装审计必须提供 --current")
    }
    return output
}

function errorPayload(code, message) {
    return {
        schemaVersion: 1,
        auditVersion: 1,
        error: { code, message },
    }
}

function classifyError(error) {
    if (error instanceof AuditCliError) return { code: error.code, message: error.message }
    if (error instanceof CatalogValidationError) {
        return {
            code: error.code,
            message: `Catalog 校验失败，共 ${error.issues.length} 项；首项代码 ${error.code}`,
        }
    }
    if (error instanceof CdnPlannerError) {
        return { code: error.code, message: `Planner 失败：${error.code}` }
    }
    return { code: "AUDIT_FAILED", message: "CDN 审计失败；未生成更新计划" }
}

function formatBytes(bytes) {
    return `${bytes.toLocaleString("zh-CN")} 字节`
}

function renderHuman(report) {
    const lines = [
        "CDN Catalog 只读审计",
        `Catalog：full base ${report.catalog.fullBaseVersion}，target ${report.catalog.targetVersion}`,
        `安装体积：${formatBytes(report.catalog.installedBytes)}`,
        `图：${report.catalog.edgeCount} 条边（diff ${report.catalog.diffEdgeCount}），校验问题 ${report.graph.validationIssueCount}`,
        `归档：${report.catalog.archiveCount} 个，压缩字节 ${formatBytes(report.catalog.archiveCompressedBytes)}`,
        `层 common：${report.catalog.layers.common.archiveCount} 个 / ${formatBytes(report.catalog.layers.common.bytes)}`,
        `层 quality：${report.catalog.layers.quality.archiveCount} 个 / ${formatBytes(report.catalog.layers.quality.bytes)}`,
        `层 platform：${report.catalog.layers.platform.archiveCount} 个 / ${formatBytes(report.catalog.layers.platform.bytes)}`,
        `范围：${report.scope.platform} / ${report.scope.assetSize}（阶段 1 实际 ${report.scope.effectiveAssetSize}）`,
        `EntityLists：${report.catalog.entityListsRelativePath}`,
    ]
    if (report.plan.kind === "up-to-date") {
        lines.push("计划：已是最新版本，full=None，diff=None，下载 0 字节")
    } else {
        lines.push(`计划：${report.plan.kind}，下载 ${formatBytes(report.plan.downloadBytes)}，delayed 0 字节`)
        if (report.plan.full) {
            lines.push(`full：${report.plan.full.version}，${report.plan.full.archiveCount} 个归档，${formatBytes(report.plan.full.bytes)}`)
        }
        for (const edge of report.plan.diff ?? []) {
            lines.push(`diff：${edge.fromVersion} -> ${edge.toVersion}，${edge.archiveCount} 个归档，${formatBytes(edge.bytes)}`)
        }
    }
    return `${lines.join("\n")}\n`
}

async function run(argv) {
    const parsed = parseArguments(argv)
    let paths
    try {
        paths = resolveContentPaths({
            projectRoot: PROJECT_ROOT,
            env: { ...process.env, ...parsed.pathOverrides },
        })
    } catch {
        throw new AuditCliError(
            "AUDIT_PATH_CONFIG_ERROR",
            "内容目录配置无效；CDN_DIR 必须指向包含 cn 子目录的父目录，且各状态目录必须隔离",
        )
    }

    const input = await scanCdnCatalogInput(paths)
    const catalog = buildCdnCatalog(input)
    const targetVersion = parsed.targetVersion ?? catalog.targetVersion
    const request = {
        currentVersion: parsed.currentVersion,
        targetVersion,
        platform: "android",
        assetSizeKind: "fulfill",
        isInitial: parsed.isInitial,
    }
    const plan = planCdnUpdate(catalog, request)
    const report = createCdnAuditReport(catalog, plan, {
        currentVersion: parsed.currentVersion,
        targetVersion,
        platform: "android",
        requestedAssetSize: parsed.assetSize,
        effectiveAssetSize: "fulfill",
        isInitial: parsed.isInitial,
    })
    return { json: parsed.json, report }
}

async function main(argv = process.argv.slice(2)) {
    const wantsJson = argv.includes("--json")
    try {
        const result = await run(argv)
        process.stdout.write(result.json
            ? `${JSON.stringify(result.report, null, 2)}\n`
            : renderHuman(result.report))
    } catch (error) {
        const classified = classifyError(error)
        if (wantsJson) {
            process.stdout.write(`${JSON.stringify(errorPayload(classified.code, classified.message), null, 2)}\n`)
        } else {
            process.stderr.write(`错误 [${classified.code}]：${classified.message}\n`)
        }
        process.exitCode = 1
    }
}

if (require.main === module) void main()

module.exports = {
    AuditCliError,
    main,
    parseArguments,
    renderHuman,
    run,
}
