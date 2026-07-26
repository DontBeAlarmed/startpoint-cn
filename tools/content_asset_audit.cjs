#!/usr/bin/env node
"use strict"

const path = require("node:path")

function runContentAssetAuditBootstrap(dependencies = {}) {
    const projectRoot = dependencies.projectRoot ?? path.resolve(__dirname, "..")
    const stderr = dependencies.stderr ?? process.stderr
    const setExitCode = dependencies.setExitCode ?? (code => { process.exitCode = code })
    try {
        const registerTsNode = dependencies.registerTsNode ?? (() => {
            require("ts-node").register({
                project: path.join(projectRoot, "tsconfig.json"),
                transpileOnly: true,
            })
        })
        registerTsNode()
        const loadMain = dependencies.loadMain ?? (() => require("../src/content/audit/cli").main)
        const status = loadMain()(process.argv.slice(2), { projectRoot })
        setExitCode(status)
        return status
    } catch {
        stderr.write("BLOCKED [CONTENT_ASSET_AUDIT_BOOTSTRAP_FAILED] content asset audit failed\n")
        setExitCode(1)
        return 1
    }
}

if (require.main === module) runContentAssetAuditBootstrap()

module.exports = { runContentAssetAuditBootstrap }
