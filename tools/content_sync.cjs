#!/usr/bin/env node
"use strict"

const fs = require("node:fs")
const path = require("node:path")

function loadOptionalProjectEnv(projectRoot, dependencies = {}) {
    const envPath = path.join(projectRoot, ".env")
    const existsSync = dependencies.existsSync ?? fs.existsSync
    if (!existsSync(envPath)) return false

    const loadEnvFile = dependencies.loadEnvFile ?? process.loadEnvFile
    if (typeof loadEnvFile !== "function") {
        throw new Error("当前 Node.js 版本无法加载 .env；请升级 Node.js 或导出环境变量")
    }
    loadEnvFile(envPath)
    return true
}

async function runContentSyncBootstrap(dependencies = {}) {
    const projectRoot = dependencies.projectRoot ?? path.resolve(__dirname, "..")
    const stderr = dependencies.stderr ?? process.stderr
    const setExitCode = dependencies.setExitCode ?? (code => { process.exitCode = code })
    try {
        const loadEnv = dependencies.loadEnv ?? loadOptionalProjectEnv
        loadEnv(projectRoot)
        const registerTsNode = dependencies.registerTsNode ?? (() => {
            require("ts-node").register({
                project: path.join(projectRoot, "tsconfig.json"),
                transpileOnly: true,
            })
        })
        registerTsNode()
        const loadMain = dependencies.loadMain ?? (() => require("../src/content/sync/cli").main)
        return await loadMain()()
    } catch {
        stderr.write("错误 [CONTENT_SYNC_BOOTSTRAP_FAILED]：内容同步命令初始化失败\n")
        setExitCode(1)
        return 1
    }
}

if (require.main === module) {
    void runContentSyncBootstrap()
}

module.exports = { loadOptionalProjectEnv, runContentSyncBootstrap }
