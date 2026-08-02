#!/usr/bin/env node

const fs = require("node:fs")
const { spawnSync } = require("node:child_process")
const path = require("node:path")

const EXPORT_PROBE_TIMEOUT_MS = 1_000
const EXPORT_PROBE_SUCCESS = Buffer.from([1])
const EXPORT_PROBE_SCRIPT = [
    "const writeCompletion = require('node:fs').writeSync",
    "const value = require(process.argv[1])",
    "if (typeof value[process.argv[2]] !== 'function') process.exit(1)",
    "writeCompletion(3, Buffer.from([1]))",
].join(";")

const requiredFiles = [
    "cn-server.js",
    "server.js",
    "content/sync/entry.js",
    "content/startup/bootstrap.js",
    "multi/tcp/lobby.js",
    "multi/npc/controller.js",
]

const requiredExports = [
    ["content/sync/entry.js", "runContentSyncEntry"],
    ["content/startup/bootstrap.js", "runContentStartup"],
]

function verifyBuild(outputDirectory) {
    const invalidFiles = requiredFiles.filter(relativePath => (
        !fs.existsSync(path.join(outputDirectory, relativePath))
    ))
    for (const [relativePath, exportName] of requiredExports) {
        if (invalidFiles.includes(relativePath)) continue
        const modulePath = path.join(outputDirectory, relativePath)
        const probe = spawnSync(process.execPath, [
            "-e",
            EXPORT_PROBE_SCRIPT,
            modulePath,
            exportName,
        ], {
            stdio: ["ignore", "ignore", "ignore", "pipe"],
            timeout: EXPORT_PROBE_TIMEOUT_MS,
            killSignal: "SIGKILL",
        })
        const completed = Buffer.isBuffer(probe.output?.[3])
            && probe.output[3].equals(EXPORT_PROBE_SUCCESS)
        if (probe.error || probe.signal !== null || probe.status !== 0 || !completed) {
            invalidFiles.push(relativePath)
        }
    }
    return invalidFiles
}

function main(argv = process.argv.slice(2)) {
    const outputDirectory = path.resolve(argv[0] ?? "out")
    const missingFiles = verifyBuild(outputDirectory)

    if (missingFiles.length > 0) {
        process.stderr.write("CN build verification failed; missing or invalid required files:\n")
        for (const relativePath of missingFiles) {
            process.stderr.write(`  - ${relativePath}\n`)
        }
        return 1
    }

    process.stdout.write("CN build verified\n")
    return 0
}

if (require.main === module) {
    process.exitCode = main()
}

module.exports = {
    main,
    verifyBuild,
}
