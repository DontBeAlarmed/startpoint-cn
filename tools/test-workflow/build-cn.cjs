#!/usr/bin/env node
"use strict"

const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

function processStatus(result) {
    if (result?.error || result?.signal !== null || !Number.isInteger(result?.status)) return 1
    return result.status
}

function runCnBuild(dependencies = {}) {
    const projectRoot = path.resolve(dependencies.projectRoot ?? path.resolve(__dirname, "../.."))
    const executable = dependencies.executable ?? process.execPath
    const spawn = dependencies.spawnSync ?? spawnSync
    const stderr = dependencies.stderr ?? process.stderr
    const removeBuildInfo = dependencies.removeBuildInfo
        ?? (filePath => fs.rmSync(filePath, { force: true }))
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

    const run = (stage, args) => {
        try {
            return processStatus(spawn(executable, args, spawnOptions))
        } catch {
            stderr.write(`CN build ${stage} process failed to start\n`)
            return 1
        }
    }

    const firstCompileStatus = run("TypeScript", tscArgs)
    if (firstCompileStatus !== 0) return firstCompileStatus

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
    return run("recovery verifier", verifierArgs)
}

if (require.main === module) {
    process.exitCode = runCnBuild()
}

module.exports = { runCnBuild }
