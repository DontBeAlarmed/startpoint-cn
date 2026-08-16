"use strict"

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const RUNTIME_COMMIT_MARKER = ".oracle-runtime-commit"

function getDirectoryLinkType(platform = process.platform) {
    return platform === "win32" ? "junction" : "dir"
}

function runChecked(command, args, options = {}, spawn = spawnSync) {
    const result = spawn(command, args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        ...options,
    })
    if (result.error?.code === "ENOENT") {
        throw new Error(`Required oracle command "${command}" is unavailable`, {
            cause: result.error,
        })
    }
    if (result.error) throw result.error
    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim()
            || `${command} ${args.join(" ")} failed with ${result.status}`)
    }
    return result
}

function resolveCommit(projectRoot, expectedCommit) {
    const result = runChecked(
        "git",
        ["rev-parse", "--verify", `${expectedCommit}^{commit}`],
        { cwd: projectRoot },
    )
    const resolved = result.stdout.trim()
    if (resolved !== expectedCommit) {
        throw new Error(`Oracle commit resolved to ${resolved}, expected ${expectedCommit}`)
    }
    return resolved
}

function runGitObjectCollector({
    collectorPath,
    expectedCommit,
    projectRoot,
    timeoutMs = 60_000,
}) {
    const runtimeCommit = resolveCommit(projectRoot, expectedCommit)
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mission-git-oracle-"))
    const archivePath = path.join(temporaryRoot, "runtime.tar")
    const runtimeRoot = path.join(temporaryRoot, "runtime")
    fs.mkdirSync(runtimeRoot)
    try {
        runChecked(
            "git",
            ["archive", "--format=tar", `--output=${archivePath}`, runtimeCommit],
            { cwd: projectRoot },
        )
        runChecked("tar", ["-xf", archivePath, "-C", runtimeRoot])
        fs.symlinkSync(
            path.join(projectRoot, "node_modules"),
            path.join(runtimeRoot, "node_modules"),
            getDirectoryLinkType(),
        )
        fs.writeFileSync(
            path.join(runtimeRoot, RUNTIME_COMMIT_MARKER),
            `${runtimeCommit}\n`,
            "utf8",
        )
        return runChecked(
            process.execPath,
            [collectorPath, runtimeRoot],
            { cwd: projectRoot, timeout: timeoutMs },
        ).stdout
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true })
    }
}

module.exports = {
    RUNTIME_COMMIT_MARKER,
    getDirectoryLinkType,
    runChecked,
    runGitObjectCollector,
}
