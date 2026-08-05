"use strict"

require("ts-node/register/transpile-only")

const path = require("node:path")
const {
    MultiHubCredentialStore,
} = require("../src/multi/hub/credential-store")
const {
    resolveMultiHubCredentialsPath,
} = require("../src/runtime/config")

function usage() {
    process.stderr.write(
        "Usage: manage_multi_hub_token.cjs create <label> | list | revoke <credentialId>\n",
    )
    process.exitCode = 2
}

function print(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function main() {
    const [command, ...args] = process.argv.slice(2)
    if (!command) return usage()
    if (command === "create" && process.env.MULTI_MODE === "client") {
        const error = new Error("Client mode cannot issue Host credentials")
        error.code = "CLIENT_CANNOT_ISSUE_MULTI_HUB_CREDENTIAL"
        throw error
    }
    const projectRoot = path.resolve(__dirname, "..")
    const credentialsPath = resolveMultiHubCredentialsPath(process.env, projectRoot)
    const store = new MultiHubCredentialStore({ credentialsPath })

    if (command === "create" && args.length === 1) {
        print(store.create(args[0]))
        return
    }
    if (command === "list" && args.length === 0) {
        print(store.list().map(credential => ({
            ...credential,
            credentialId: `${credential.credentialId.slice(0, 8)}...`,
        })))
        return
    }
    if (command === "revoke" && args.length === 1) {
        print(store.revoke(args[0]))
        return
    }
    usage()
}

try {
    main()
} catch (error) {
    const code = typeof error?.code === "string" ? error.code : "UNKNOWN"
    process.stderr.write(`Multi Hub credential command failed: ${code}\n`)
    process.exitCode = 1
}
