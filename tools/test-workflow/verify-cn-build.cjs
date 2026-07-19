#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")

const requiredFiles = [
    "cn-server.js",
    "multi/tcp/lobby.js",
    "multi/npc/controller.js",
]

function verifyBuild(outputDirectory) {
    return requiredFiles.filter(relativePath => (
        !fs.existsSync(path.join(outputDirectory, relativePath))
    ))
}

function main(argv = process.argv.slice(2)) {
    const outputDirectory = path.resolve(argv[0] ?? "out")
    const missingFiles = verifyBuild(outputDirectory)

    if (missingFiles.length > 0) {
        process.stderr.write(`CN build verification failed; missing files in ${outputDirectory}:\n`)
        for (const relativePath of missingFiles) {
            process.stderr.write(`  - ${relativePath}\n`)
        }
        return 1
    }

    process.stdout.write(`CN build verified: ${outputDirectory}\n`)
    return 0
}

if (require.main === module) {
    process.exitCode = main()
}

module.exports = {
    main,
    verifyBuild,
}
