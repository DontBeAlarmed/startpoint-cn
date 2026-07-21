#!/usr/bin/env node
"use strict"

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

require("ts-node").register({
    project: path.resolve(__dirname, "../tsconfig.json"),
    transpileOnly: true,
})

const { resolveContentPaths } = require("../src/content/paths")
const {
    buildCdnCatalog,
    scanCdnCatalogInput,
} = require("../src/content/cdn/catalog-builder")
const {
    createCdnRuntimeManifest,
    serializeCdnRuntimeManifest,
} = require("../src/content/cdn/runtime-manifest")

const PROJECT_ROOT = path.resolve(__dirname, "..")
const MAX_ARGUMENT_VALUE_LENGTH = 4096
const VALUE_OPTIONS = new Map([
    ["--output", "outputPath"],
    ["--cdn-dir", "CDN_DIR"],
    ["--content-state-dir", "CONTENT_STATE_DIR"],
    ["--content-store-dir", "CONTENT_STORE_DIR"],
    ["--content-runtime-dir", "CONTENT_RUNTIME_DIR"],
])

class ManifestCliError extends Error {
    constructor(code, message) {
        super(message)
        this.name = "ManifestCliError"
        this.code = code
    }
}

function parseArguments(argv) {
    const output = {
        outputPath: null,
        pathOverrides: {},
    }
    const seen = new Set()

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        const property = VALUE_OPTIONS.get(argument)
        if (!property) throw new ManifestCliError("MANIFEST_UNKNOWN_ARGUMENT", "存在未知参数")
        if (seen.has(argument)) {
            throw new ManifestCliError("MANIFEST_DUPLICATE_ARGUMENT", `参数 ${argument} 不能重复`)
        }
        seen.add(argument)

        const value = argv[index + 1]
        if (value === undefined || value === "" || value.startsWith("--")) {
            throw new ManifestCliError("MANIFEST_MISSING_ARGUMENT_VALUE", `参数 ${argument} 缺少值`)
        }
        if (value.length > MAX_ARGUMENT_VALUE_LENGTH) {
            throw new ManifestCliError("MANIFEST_ARGUMENT_VALUE_TOO_LONG", "参数值过长")
        }
        index++

        if (property === "outputPath") output.outputPath = value
        else output.pathOverrides[property] = value
    }

    return output
}

function isSameOrDescendant(parent, candidate) {
    const relativePath = path.relative(parent, candidate)
    return relativePath === ""
        || (!path.isAbsolute(relativePath)
            && relativePath !== ".."
            && !relativePath.startsWith(`..${path.sep}`))
}

async function run(argv, dependencies = {}) {
    const parsed = parseArguments(argv)
    const projectRoot = dependencies.projectRoot ?? PROJECT_ROOT
    const cwd = dependencies.cwd ?? process.cwd()
    const env = dependencies.env ?? process.env
    const paths = (dependencies.resolvePaths ?? resolveContentPaths)({
        projectRoot,
        env: { ...env, ...parsed.pathOverrides },
    })
    const outputPath = parsed.outputPath === null ? null : path.resolve(cwd, parsed.outputPath)
    if (outputPath !== null
        && (isSameOrDescendant(paths.cdnDir, outputPath)
            || isSameOrDescendant(paths.contentRuntimeDir, outputPath))) {
        throw new ManifestCliError(
            "MANIFEST_OUTPUT_FORBIDDEN",
            "output 不能位于 CDN 或内容运行时目录内",
        )
    }
    const input = await (dependencies.scanCatalogInput ?? scanCdnCatalogInput)(paths)
    const catalog = (dependencies.buildCatalog ?? buildCdnCatalog)(input)
    if (catalog.targetVersion !== "1.4.54") {
        throw new ManifestCliError(
            "MANIFEST_UNSUPPORTED_TARGET",
            `Catalog target 必须是 1.4.54，实际为 ${catalog.targetVersion}`,
        )
    }

    const entityPath = path.join(paths.cdnRoot, input.entityListsRelativePath)
    const entityBytes = await (dependencies.readFile ?? fs.promises.readFile)(entityPath)
    const entityLists = {
        relativePath: input.entityListsRelativePath,
        compressedBytes: entityBytes.length,
        sha256: crypto.createHash("sha256").update(entityBytes).digest("hex"),
    }
    const manifest = (dependencies.createManifest ?? createCdnRuntimeManifest)(input, entityLists)
    return {
        serialized: (dependencies.serializeManifest ?? serializeCdnRuntimeManifest)(manifest),
        outputPath,
    }
}

async function executeManifestCli(argv, dependencies = {}) {
    const stdout = dependencies.stdout ?? process.stdout
    const stderr = dependencies.stderr ?? process.stderr
    const mkdir = dependencies.mkdir ?? (directory => fs.promises.mkdir(directory, { recursive: true }))
    const writeFile = dependencies.writeFile ?? ((filePath, value) => fs.promises.writeFile(filePath, value, "utf8"))
    const setExitCode = dependencies.setExitCode ?? (code => { process.exitCode = code })
    const runManifest = dependencies.runManifest ?? run

    try {
        const result = await runManifest(argv, dependencies)
        if (result.outputPath === null) {
            stdout.write(result.serialized)
        } else {
            await mkdir(path.dirname(result.outputPath))
            await writeFile(result.outputPath, result.serialized)
        }
        setExitCode(0)
        return 0
    } catch (error) {
        const code = error instanceof ManifestCliError ? error.code : "MANIFEST_GENERATION_FAILED"
        const message = error instanceof Error ? error.message : "CDN runtime manifest 生成失败"
        stderr.write(`错误 [${code}]：${message}\n`)
        setExitCode(1)
        return 1
    }
}

async function main(argv = process.argv.slice(2)) {
    return executeManifestCli(argv)
}

if (require.main === module) void main()

module.exports = {
    ManifestCliError,
    executeManifestCli,
    main,
    parseArguments,
    run,
}
