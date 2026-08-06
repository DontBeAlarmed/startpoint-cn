"use strict"

require("ts-node/register/transpile-only")

const readline = require("node:readline/promises")
const path = require("node:path")
const {
    createOfflineMultiManagementService,
} = require("../src/multi/management/offline")
const {
    isInteractiveTerminal,
    maybeWriteMultiHubTokenEnv,
} = require("./lib/multi-hub-env.cjs")

function usage() {
    process.stderr.write(
        "Usage: manage_multi_hub_token.cjs create <label> | list | revoke <credentialId>\n",
    )
    process.exitCode = 2
}

function print(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function confirm(question) {
    const input = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
    })
    try {
        const suffix = question.defaultValue ? "[Y/n]" : "[y/N]"
        const answer = (await input.question(`${question.message} ${suffix} `)).trim().toLowerCase()
        if (answer === "") return question.defaultValue
        return answer === "y" || answer === "yes"
    } finally {
        input.close()
    }
}

async function main() {
    const [command, ...args] = process.argv.slice(2)
    if (!command) return usage()
    const projectRoot = path.resolve(__dirname, "..")
    const service = createOfflineMultiManagementService({ projectRoot, env: process.env })

    if (command === "create" && args.length === 1) {
        const issued = service.createCredential(args[0])
        print(issued)
        await maybeWriteMultiHubTokenEnv({
            envPath: path.join(projectRoot, ".env"),
            token: issued.token,
            interactive: isInteractiveTerminal(process.stdin, process.stderr),
            confirm,
        })
        return
    }
    if (command === "list" && args.length === 0) {
        print(service.listCredentials())
        return
    }
    if (command === "revoke" && args.length === 1) {
        print(service.revokeCredential(args[0]))
        return
    }
    usage()
}

main().catch(error => {
    const code = typeof error?.code === "string" ? error.code : "UNKNOWN"
    process.stderr.write(`Multi Hub credential command failed: ${code}\n`)
    process.exitCode = 1
})
