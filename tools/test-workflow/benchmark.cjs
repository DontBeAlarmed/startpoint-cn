#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "../..")
const signalExitCodes = { SIGINT: 130, SIGTERM: 143 }

const DEFAULT_COMMANDS = Object.freeze([
    Object.freeze({
        args: ["run", "test:quick"],
        command: "npm run test:quick",
        name: "test:quick",
        thresholdMs: 5000,
        timeoutMs: 30000,
    }),
    Object.freeze({
        args: ["run", "test:changed", "--", "--files", "src/lib/gacha.ts"],
        command: "npm run test:changed -- --files src/lib/gacha.ts",
        name: "test:changed",
        thresholdMs: 20000,
        timeoutMs: 60000,
    }),
    Object.freeze({
        args: ["run", "test:integration"],
        command: "npm run test:integration",
        name: "test:integration",
        thresholdMs: 30000,
        timeoutMs: 90000,
    }),
    Object.freeze({
        args: ["run", "test:full"],
        command: "npm run test:full",
        name: "test:full",
        thresholdMs: 60000,
        timeoutMs: 120000,
    }),
    Object.freeze({
        args: ["run", "typecheck"],
        command: "npm run typecheck",
        name: "typecheck",
        thresholdMs: 30000,
        timeoutMs: 90000,
    }),
])

function median(samples) {
    if (!Array.isArray(samples) || samples.length === 0) {
        throw new TypeError("median requires at least one numeric sample")
    }
    if (samples.some(sample => !Number.isFinite(sample))) {
        throw new TypeError("median samples must be finite numbers")
    }

    const sorted = [...samples].sort((left, right) => left - right)
    const midpoint = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1
        ? sorted[midpoint]
        : (sorted[midpoint - 1] + sorted[midpoint]) / 2
}

function evaluateThreshold({ commandExitCodes, medianMs, reportOnly, thresholdMs }) {
    const commandSucceeded = commandExitCodes.every(exitCode => exitCode === 0)
    const withinThreshold = medianMs <= thresholdMs
    return {
        commandSucceeded,
        exitCode: commandSucceeded && (withinThreshold || reportOnly) ? 0 : 1,
        withinThreshold,
    }
}

function parseRunnerSummary(output) {
    const pattern = /Summary:\s*passed=(\d+)\s+failed=(\d+)\s+skipped=(\d+)\b/g
    let match
    let summary = null
    while ((match = pattern.exec(output)) !== null) {
        summary = {
            failed: Number(match[2]),
            passed: Number(match[1]),
            skipped: Number(match[3]),
        }
    }
    return summary
}

function parseArguments(argv) {
    const parsed = { only: null, output: null, reportOnly: false }

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        if (argument === "--report-only") {
            parsed.reportOnly = true
            continue
        }
        if (argument === "--output" || argument === "--only") {
            const value = argv[++index]
            if (!value || value.startsWith("--")) {
                throw new Error(`${argument} requires a value`)
            }
            const key = argument === "--output" ? "output" : "only"
            if (parsed[key] !== null) throw new Error(`${argument} may only be provided once`)
            parsed[key] = value
            continue
        }
        throw new Error(`unknown argument: ${argument}`)
    }

    return parsed
}

function terminateProcessGroup(child, signal) {
    if (!child?.pid) return
    try {
        if (process.platform === "win32") child.kill(signal)
        else process.kill(-child.pid, signal)
    } catch (error) {
        if (error.code !== "ESRCH") throw error
    }
}

function runCommand(command, state, options = {}) {
    const cwd = options.cwd ?? projectRoot
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
    const forceKillAfterMs = options.forceKillAfterMs ?? 2000

    return new Promise(resolve => {
        const startedAt = process.hrtime.bigint()
        const child = spawn(npmCommand, command.args, {
            cwd,
            detached: process.platform !== "win32",
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        })
        state.activeChild = child

        let output = ""
        let timedOut = false
        let spawnError = null
        let forceKillTimer = null

        const timeoutTimer = setTimeout(() => {
            timedOut = true
            output += `\nbenchmark timeout after ${command.timeoutMs}ms\n`
            try {
                terminateProcessGroup(child, "SIGTERM")
            } catch (error) {
                output += `failed to terminate command: ${error.message}\n`
            }
            forceKillTimer = setTimeout(() => {
                try {
                    terminateProcessGroup(child, "SIGKILL")
                } catch (error) {
                    output += `failed to kill command: ${error.message}\n`
                }
            }, forceKillAfterMs)
        }, command.timeoutMs)

        child.stdout.on("data", chunk => { output += chunk })
        child.stderr.on("data", chunk => { output += chunk })
        child.on("error", error => {
            spawnError = error
            output += `${error.stack || error.message}\n`
        })
        child.on("close", (exitCode, signal) => {
            clearTimeout(timeoutTimer)
            if (forceKillTimer !== null) clearTimeout(forceKillTimer)
            if (state.activeChild === child) state.activeChild = null

            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
            const summary = parseRunnerSummary(output) ?? { failed: 0, passed: 0, skipped: 0 }
            resolve({
                durationMs,
                failed: summary.failed,
                output,
                passed: summary.passed,
                rawExitCode: exitCode,
                signal,
                skipped: summary.skipped,
                spawnError: spawnError?.message ?? null,
                timedOut,
            })
        })
    })
}

function rawExitCodeForEvaluation(run) {
    return run.rawExitCode === 0 && !run.timedOut && run.spawnError === null ? 0 : 1
}

function roundMilliseconds(value) {
    return Math.round(value * 1000) / 1000
}

function latestCounts(runs) {
    for (let index = runs.length - 1; index >= 0; index--) {
        const run = runs[index]
        if (run.passed !== 0 || run.failed !== 0 || run.skipped !== 0) {
            return { failed: run.failed, passed: run.passed, skipped: run.skipped }
        }
    }
    return { failed: 0, passed: 0, skipped: 0 }
}

function compactRun(run) {
    return {
        durationMs: roundMilliseconds(run.durationMs),
        failed: run.failed,
        passed: run.passed,
        rawExitCode: run.rawExitCode,
        signal: run.signal,
        skipped: run.skipped,
        timedOut: run.timedOut,
    }
}

async function benchmarkCommand(command, state, options = {}) {
    const writeStatus = options.writeStatus ?? (value => process.stderr.write(value))
    writeStatus(`[benchmark] ${command.name}: warm-up\n`)
    const warmup = await runCommand(command, state, options)
    const runs = []

    for (let attempt = 1; attempt <= 3 && state.interruptedBy === null; attempt++) {
        writeStatus(`[benchmark] ${command.name}: run ${attempt}/3\n`)
        runs.push(await runCommand(command, state, options))
    }

    if (runs.length !== 3) return null
    const durationsMs = runs.map(run => roundMilliseconds(run.durationMs))
    const medianMs = roundMilliseconds(median(durationsMs))
    const commandExitCodes = [warmup, ...runs].map(rawExitCodeForEvaluation)
    const evaluation = evaluateThreshold({
        commandExitCodes,
        medianMs,
        reportOnly: options.reportOnly ?? false,
        thresholdMs: command.thresholdMs,
    })
    const counts = latestCounts(runs)
    const status = !evaluation.commandSucceeded
        ? "command-failed"
        : evaluation.withinThreshold ? "passed" : "threshold-exceeded"

    return {
        command: command.command,
        commandSucceeded: evaluation.commandSucceeded,
        durationsMs,
        exitCode: evaluation.exitCode,
        failed: counts.failed,
        medianMs,
        name: command.name,
        passed: counts.passed,
        rawExitCodes: runs.map(run => run.rawExitCode),
        runs: runs.map(compactRun),
        skipped: counts.skipped,
        status,
        thresholdMs: command.thresholdMs,
        warmup: compactRun(warmup),
        withinThreshold: evaluation.withinThreshold,
    }
}

function readCommit(cwd) {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr.trim() || "git rev-parse HEAD failed")
    return result.stdout.trim()
}

function writeReport(report, outputPath, cwd) {
    const serialized = `${JSON.stringify(report, null, 2)}\n`
    if (outputPath === null) {
        process.stdout.write(serialized)
        return
    }

    const resolvedPath = path.resolve(cwd, outputPath)
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
    fs.writeFileSync(resolvedPath, serialized)
    process.stdout.write(`benchmark report: ${resolvedPath}\n`)
}

function installSignalHandlers(state, options = {}) {
    const forceKillAfterMs = options.forceKillAfterMs ?? 2000
    const handlers = {}
    let forceKillTimer = null

    for (const signal of Object.keys(signalExitCodes)) {
        handlers[signal] = () => {
            if (state.interruptedBy !== null) return
            state.interruptedBy = signal
            if (!state.activeChild) return
            try {
                terminateProcessGroup(state.activeChild, signal)
            } finally {
                forceKillTimer = setTimeout(() => {
                    try {
                        terminateProcessGroup(state.activeChild, "SIGKILL")
                    } catch (error) {
                        if (error.code !== "ESRCH") process.stderr.write(`${error.message}\n`)
                    }
                }, forceKillAfterMs)
            }
        }
        process.on(signal, handlers[signal])
    }

    return () => {
        if (forceKillTimer !== null) clearTimeout(forceKillTimer)
        for (const [signal, handler] of Object.entries(handlers)) {
            process.off(signal, handler)
        }
    }
}

async function main(argv = process.argv.slice(2), options = {}) {
    const cwd = options.cwd ?? projectRoot
    const writeError = options.writeError ?? (value => process.stderr.write(value))
    const state = { activeChild: null, interruptedBy: null }
    let removeSignalHandlers = () => {}

    try {
        const parsed = parseArguments(argv)
        const commands = parsed.only === null
            ? DEFAULT_COMMANDS
            : DEFAULT_COMMANDS.filter(command => command.name === parsed.only)
        if (commands.length === 0) {
            throw new Error(`unknown benchmark command: ${parsed.only}`)
        }

        const report = {
            schemaVersion: 1,
            commit: readCommit(cwd),
            nodeVersion: process.version,
            startedAt: new Date().toISOString(),
            commands: [],
        }
        removeSignalHandlers = installSignalHandlers(state, options)

        for (const command of commands) {
            if (state.interruptedBy !== null) break
            const result = await benchmarkCommand(command, state, {
                ...options,
                reportOnly: parsed.reportOnly,
            })
            if (result !== null) report.commands.push(result)
        }

        if (state.interruptedBy !== null) return signalExitCodes[state.interruptedBy]
        writeReport(report, parsed.output, cwd)
        return report.commands.some(command => command.exitCode !== 0) ? 1 : 0
    } catch (error) {
        writeError(`${error.stack || error.message}\n`)
        return 2
    } finally {
        removeSignalHandlers()
    }
}

if (require.main === module) {
    main().then(exitCode => {
        process.exitCode = exitCode
    })
}

module.exports = {
    DEFAULT_COMMANDS,
    benchmarkCommand,
    evaluateThreshold,
    main,
    median,
    parseArguments,
    parseRunnerSummary,
}
