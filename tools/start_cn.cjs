#!/usr/bin/env node
"use strict"

const fs = require("node:fs")
const os = require("node:os")
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

function applyStartupOutcome(outcome, dependencies = {}) {
    const setExitCode = dependencies.setExitCode ?? (code => { process.exitCode = code })
    if (outcome.signal === null) {
        setExitCode(outcome.code ?? 1)
        return
    }

    const signalSelf = dependencies.signalSelf ?? (signal => process.kill(process.pid, signal))
    try {
        signalSelf(outcome.signal)
    } catch {
        const signalNumber = os.constants.signals[outcome.signal]
        setExitCode(typeof signalNumber === "number" ? 128 + signalNumber : 1)
    }
}

async function runStartCn(dependencies = {}) {
    const projectRoot = dependencies.projectRoot ?? path.resolve(__dirname, "..")
    const stderr = dependencies.stderr ?? process.stderr
    const applyOutcome = dependencies.applyOutcome ?? applyStartupOutcome
    try {
        const loadEnv = dependencies.loadEnv ?? loadOptionalProjectEnv
        loadEnv(projectRoot)
        const bootstrapPath = path.join(projectRoot, "out/content/startup/bootstrap.js")
        const loadBootstrap = dependencies.loadBootstrap ?? require
        const { runContentStartup } = loadBootstrap(bootstrapPath)
        const outcome = await runContentStartup({ projectRoot })
        applyOutcome(outcome)
        return outcome
    } catch {
        stderr.write("错误 [CONTENT_STARTUP_BOOTSTRAP_FAILED]：CN 启动入口初始化失败\n")
        const outcome = { code: 1, signal: null }
        applyOutcome(outcome)
        return outcome
    }
}

if (require.main === module) {
    void runStartCn()
}

module.exports = { applyStartupOutcome, loadOptionalProjectEnv, runStartCn }
