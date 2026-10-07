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
        "Usage: manage_multi_hub_token.cjs create <label> | list | revoke <credentialId> | rebuild\n",
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
    if (command === "rebuild" && args.length === 0) {
        // S4（stale-guard 自愈专项）：凭据表损坏后的显式恢复（经由 management
        // service，与既有 create/list/revoke 同一架构门）。不做自动重建——
        // 静默清空安全敏感文件不可接受，必须管理者显式确认。
        if (!isInteractiveTerminal(process.stdin, process.stderr)) {
            process.stderr.write("rebuild requires an interactive terminal to confirm; aborted\n")
            process.exitCode = 1
            return
        }
        const confirmed = await confirm({
            message: "rebuild 会把现有凭据表改名留存并从空表重建，已分发的全部令牌将失效（需重新分发）。确认？",
            defaultValue: false,
        })
        if (!confirmed) {
            process.stderr.write("rebuild aborted\n")
            return
        }
        const result = service.rebuildCredentials()
        print({
            ...result,
            warning: "已分发令牌全部失效；请重新 create 并重新分发各 client 节点令牌",
        })
        return
    }
    usage()
}

main().catch(error => {
    const code = typeof error?.code === "string" ? error.code : "UNKNOWN"
    process.stderr.write(`Multi Hub credential command failed: ${code}\n`)
    process.exitCode = 1
})
