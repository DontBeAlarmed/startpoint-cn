#!/usr/bin/env node
"use strict"

const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

const COMPILED_SUFFIXES = [".d.ts.map", ".js.map", ".d.ts", ".js"]
const SOURCE_SUFFIXES = [".ts", ".tsx", ".cts", ".mts"]

function processStatus(result, stage, stderr) {
    if (result?.error) {
        stderr.write(`CN build ${stage} process failed: ${result.error.message}\n`)
        return 1
    }
    if (result?.signal !== null) {
        stderr.write(`CN build ${stage} process terminated by ${result.signal}\n`)
        return 1
    }
    if (!Number.isInteger(result?.status)) {
        stderr.write(`CN build ${stage} process returned no exit status\n`)
        return 1
    }
    return result.status
}

function hasRequiredAdminBuild(projectRoot) {
    try {
        const status = fs.lstatSync(path.join(projectRoot, "web/dist/index.html"))
        return status.isFile() && !status.isSymbolicLink()
    } catch {
        return false
    }
}

function removeOrphanCompiledFiles(sourceDirectory, outputDirectory) {
    if (!fs.existsSync(outputDirectory)) return []
    const removed = []

    const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const filePath = path.join(directory, entry.name)
            if (entry.isDirectory()) {
                visit(filePath)
                continue
            }
            const relativePath = path.relative(outputDirectory, filePath)
            const suffix = COMPILED_SUFFIXES.find(candidate => relativePath.endsWith(candidate))
            if (suffix === undefined) continue
            const sourceStem = relativePath.slice(0, -suffix.length)
            const sourceExists = SOURCE_SUFFIXES.some(candidate => (
                fs.existsSync(path.join(sourceDirectory, `${sourceStem}${candidate}`))
            ))
            if (sourceExists) continue
            fs.rmSync(filePath, { force: true })
            removed.push(relativePath.split(path.sep).join("/"))
        }
    }

    visit(outputDirectory)
    return removed.sort()
}

function runCnBuild(dependencies = {}) {
    const projectRoot = path.resolve(dependencies.projectRoot ?? path.resolve(__dirname, "../.."))
    const platform = dependencies.platform ?? process.platform
    const executable = dependencies.executable ?? process.execPath
    const npmExecutable = dependencies.npmExecutable ?? (platform === "win32" ? "npm.cmd" : "npm")
    const spawn = dependencies.spawnSync ?? spawnSync
    const stderr = dependencies.stderr ?? process.stderr
    const removeBuildInfo = dependencies.removeBuildInfo
        ?? (filePath => fs.rmSync(filePath, { force: true }))
    const cleanOrphanCompiledFiles = dependencies.cleanOrphanCompiledFiles
        ?? (() => removeOrphanCompiledFiles(
            path.join(projectRoot, "src"),
            path.join(projectRoot, "out"),
        ))
    const verifyAdminBuild = dependencies.verifyAdminBuild
        ?? (() => hasRequiredAdminBuild(projectRoot))
    const spawnOptions = {
        cwd: projectRoot,
        shell: false,
        stdio: "inherit",
    }
    const tscArgs = [
        "--max-old-space-size=4096",
        path.join(projectRoot, "node_modules/typescript/bin/tsc"),
        "-p",
        path.join(projectRoot, "tsconfig.cn.json"),
    ]
    const verifierArgs = [
        path.join(projectRoot, "tools/test-workflow/verify-cn-build.cjs"),
        path.join(projectRoot, "out"),
    ]

    const run = (stage, args, command = executable) => {
        const useShell = platform === "win32" && /\.(cmd|bat)$/i.test(command)
        try {
            return processStatus(
                spawn(command, args, { ...spawnOptions, shell: useShell }),
                stage,
                stderr,
            )
        } catch {
            stderr.write(`CN build ${stage} process failed to start\n`)
            return 1
        }
    }

    const adminBuildStatus = run("admin", ["run", "build:admin"], npmExecutable)
    if (adminBuildStatus !== 0) return adminBuildStatus
    let adminReady = false
    try {
        adminReady = verifyAdminBuild()
    } catch {
        adminReady = false
    }
    if (!adminReady) {
        stderr.write("CN build admin output invalid: web/dist/index.html is required\n")
        return 1
    }

    const firstCompileStatus = run("TypeScript", tscArgs)
    if (firstCompileStatus !== 0) return firstCompileStatus
    try {
        cleanOrphanCompiledFiles()
    } catch {
        stderr.write("CN build orphan output cleanup failed\n")
        return 1
    }

    const firstVerifyStatus = run("verifier", verifierArgs)
    if (firstVerifyStatus === 0) return 0

    stderr.write("CN build output invalid; retrying without incremental state\n")
    try {
        removeBuildInfo(path.join(projectRoot, "out/.tsbuildinfo-cn"))
    } catch {
        stderr.write("CN build incremental state cleanup failed\n")
        return 1
    }

    const recoveryCompileStatus = run("recovery TypeScript", tscArgs)
    if (recoveryCompileStatus !== 0) return recoveryCompileStatus
    try {
        cleanOrphanCompiledFiles()
    } catch {
        stderr.write("CN build orphan output cleanup failed\n")
        return 1
    }
    return run("recovery verifier", verifierArgs)
}

if (require.main === module) {
    process.exitCode = runCnBuild()
}

module.exports = { hasRequiredAdminBuild, removeOrphanCompiledFiles, runCnBuild }
