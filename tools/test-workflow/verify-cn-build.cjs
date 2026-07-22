#!/usr/bin/env node

const fs = require("node:fs")
const { spawnSync } = require("node:child_process")
const path = require("node:path")

const requiredFiles = [
    "cn-server.js",
    "content/startup/bootstrap.js",
    "multi/tcp/lobby.js",
    "multi/npc/controller.js",
]

function verifyBuild(outputDirectory) {
    const invalidFiles = requiredFiles.filter(relativePath => (
        !fs.existsSync(path.join(outputDirectory, relativePath))
    ))
    const bootstrapRelativePath = "content/startup/bootstrap.js"
    if (!invalidFiles.includes(bootstrapRelativePath)) {
        const bootstrapPath = path.join(outputDirectory, bootstrapRelativePath)
        const probe = spawnSync(process.execPath, [
            "-e",
            "const value = require(process.argv[1]); if (typeof value.runContentStartup !== 'function') process.exit(1)",
            bootstrapPath,
        ], { stdio: "ignore" })
        if (probe.error || probe.signal !== null || probe.status !== 0) {
            invalidFiles.push(bootstrapRelativePath)
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
