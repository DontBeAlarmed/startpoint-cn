#!/usr/bin/env node

const path = require("node:path")
const { spawn, spawnSync } = require("node:child_process")

const { AGGREGATE_GROUPS, TEST_GROUPS } = require("./groups.cjs")
const { selectTestGroups } = require("./select-tests.cjs")

const projectRoot = path.resolve(__dirname, "../..")
const signalExitCodes = { SIGINT: 130, SIGTERM: 143 }

function parseArguments(argv) {
    let mode = null
    let group = null
    let base = null
    const files = []
    let selectorCount = 0

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]

        if (argument === "--group") {
            const value = argv[++index]
            if (!value || value.startsWith("--")) throw new Error("--group requires a name")
            mode = "group"
            group = value
            selectorCount++
            continue
        }

        if (argument === "--files") {
            mode = "files"
            selectorCount++
            while (argv[index + 1] && !argv[index + 1].startsWith("--")) {
                files.push(argv[++index])
            }
            if (files.length === 0) throw new Error("--files requires at least one path")
            continue
        }

        if (argument === "--changed") {
            mode = "changed"
            selectorCount++
            continue
        }

        if (argument === "--base") {
            const value = argv[++index]
            if (!value || value.startsWith("--")) throw new Error("--base requires a git ref")
            base = value
            continue
        }

        throw new Error(`unknown argument: ${argument}`)
    }

    if (selectorCount > 1) {
        throw new Error("choose exactly one of --group, --files, or --changed")
    }
    if (base !== null && mode !== "changed") throw new Error("--base requires --changed")

    if (mode === null) {
        mode = "group"
        group = "quick"
    }

    return { mode, group, files, base }
}

function mergeChangedFiles(fileLists) {
    return [...new Set(fileLists.flat().filter(Boolean))]
        .sort((left, right) => left.localeCompare(right))
}

function readGitFileList(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (result.error) throw result.error
    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`)
    }
    return result.stdout.split(/\r?\n/).filter(Boolean)
}

function getChangedFiles({ cwd = projectRoot, base = null } = {}) {
    const fileLists = [
        readGitFileList(["diff", "--name-only", "--cached"], cwd),
        readGitFileList(["diff", "--name-only"], cwd),
        readGitFileList(["ls-files", "--others", "--exclude-standard"], cwd),
    ]

    if (base !== null) {
        fileLists.push(readGitFileList(["diff", "--name-only", `${base}...HEAD`], cwd))
    }

    return mergeChangedFiles(fileLists)
}

function expandGroupNames(names, testGroups = TEST_GROUPS, aggregateGroups = AGGREGATE_GROUPS) {
    const expanded = []
    const seen = new Set()

    for (const name of names) {
        const leafNames = testGroups[name]
            ? [name]
            : aggregateGroups[name]
        if (!leafNames) throw new Error(`unknown group: ${name}`)

        for (const leafName of leafNames) {
            if (!testGroups[leafName]) throw new Error(`unknown group: ${leafName}`)
            if (!seen.has(leafName)) {
                seen.add(leafName)
                expanded.push(leafName)
            }
        }
    }

    return expanded
}

function hasExplicitSkipOutput(output) {
    return output.split(/\r?\n/).some(line =>
        /\btests?\s+(?:were\s+)?skipped\b/i.test(line)
        || /\bskipped:\s*\S/i.test(line)
        || /^\s*#\s*SKIP(?:\s|$)/.test(line)
        || /跳过/.test(line)
    )
}

function terminateChild(child, signal) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return

    try {
        if (process.platform === "win32") child.kill(signal)
        else process.kill(-child.pid, signal)
    } catch (error) {
        if (error.code !== "ESRCH") child.kill(signal)
    }
}

function runTestFile({ cwd, file, group, activeChildren, timeoutMs }) {
    return new Promise(resolve => {
        const startedAt = process.hrtime.bigint()
        const child = spawn(process.execPath, [path.resolve(cwd, file)], {
            cwd,
            detached: process.platform !== "win32",
            env: {
                ...process.env,
                TS_NODE_TRANSPILE_ONLY: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
        })
        activeChildren.add(child)

        let stdout = ""
        let stderr = ""
        let timedOut = false
        let forceKillTimer = null
        const timeout = setTimeout(() => {
            timedOut = true
            stderr += `test timed out after ${timeoutMs}ms\n`
            terminateChild(child, "SIGTERM")
            forceKillTimer = setTimeout(() => terminateChild(child, "SIGKILL"), 1000)
        }, timeoutMs)
        child.stdout.on("data", chunk => { stdout += chunk })
        child.stderr.on("data", chunk => { stderr += chunk })

        child.on("error", error => {
            stderr += `${error.stack || error.message}\n`
        })

        child.on("close", (exitCode, signal) => {
            clearTimeout(timeout)
            if (forceKillTimer !== null) clearTimeout(forceKillTimer)
            activeChildren.delete(child)
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
            const output = `${stdout}${stderr}`
            const status = timedOut
                ? "failed"
                : exitCode === 0
                ? hasExplicitSkipOutput(output) ? "skipped" : "passed"
                : "failed"

            resolve({
                durationMs,
                exitCode,
                file,
                group,
                output,
                signal,
                status,
                timedOut,
            })
        })
    })
}

async function runParallel(items, concurrency, operation, shouldStop) {
    const results = new Array(items.length)
    let nextIndex = 0

    async function worker() {
        while (nextIndex < items.length) {
            if (shouldStop()) return
            const index = nextIndex++
            results[index] = await operation(items[index])
        }
    }

    const workerCount = Math.min(concurrency, items.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    return results
}

function summarizeResults(results) {
    return results.reduce(
        (summary, result) => {
            summary[result.status]++
            return summary
        },
        { passed: 0, failed: 0, skipped: 0 },
    )
}

function formatDuration(durationMs) {
    return durationMs < 1000
        ? `${Math.round(durationMs)}ms`
        : `${(durationMs / 1000).toFixed(2)}s`
}

function printResult(result, writeOutput) {
    const label = result.status.toUpperCase()
    const target = result.file ?? "no tests configured"
    writeOutput(`[${result.group}] ${label} ${target} (${formatDuration(result.durationMs)})\n`)
    if (result.status === "failed" && result.output.trim()) {
        writeOutput(`${result.output.trimEnd()}\n`)
    }
}

async function executeTestGroups(groupNames, options = {}) {
    const cwd = options.cwd ?? projectRoot
    const testGroups = options.testGroups ?? TEST_GROUPS
    const aggregateGroups = options.aggregateGroups ?? AGGREGATE_GROUPS
    const writeOutput = options.writeOutput ?? (value => process.stdout.write(value))
    const activeChildren = options.activeChildren ?? new Set()
    const shouldStop = options.shouldStop ?? (() => false)
    const leafNames = expandGroupNames(groupNames, testGroups, aggregateGroups)
    const startedAt = process.hrtime.bigint()
    const parallelItems = []
    const serialItems = []
    const emptyResults = []

    for (const group of leafNames) {
        const definition = testGroups[group]
        if (!["parallel", "serial"].includes(definition.execution)) {
            throw new Error(`group ${group} has invalid execution mode: ${definition.execution}`)
        }
        if (definition.tests.length === 0) {
            emptyResults.push({
                durationMs: 0,
                exitCode: 0,
                file: null,
                group,
                output: "",
                signal: null,
                status: "skipped",
            })
            continue
        }

        const destination = definition.execution === "parallel" ? parallelItems : serialItems
        const timeoutMs = definition.timeoutMs
            ?? (definition.execution === "parallel" ? 30000 : 120000)
        for (const file of definition.tests) destination.push({ file, group, timeoutMs })
    }

    const runItem = item => runTestFile({ ...item, cwd, activeChildren })
    const parallelResults = (await runParallel(parallelItems, 4, runItem, shouldStop))
        .filter(Boolean)
    const serialResults = []
    for (const item of serialItems) {
        if (shouldStop()) break
        serialResults.push(await runItem(item))
    }

    const results = [...parallelResults, ...serialResults, ...emptyResults]
    for (const result of results) printResult(result, writeOutput)

    const summary = summarizeResults(results)
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    writeOutput(
        `Summary: passed=${summary.passed} failed=${summary.failed} skipped=${summary.skipped} total=${formatDuration(durationMs)}\n`,
    )

    return {
        durationMs,
        exitCode: summary.failed > 0 ? 1 : 0,
        results,
        summary,
    }
}

function installSignalHandlers(activeChildren, onSignal, options = {}) {
    const handlers = {}
    const forceKillAfterMs = options.forceKillAfterMs ?? 2000
    const forceKillTimers = new Map()
    const closeHandlers = new Map()

    function clearForceKill(child) {
        const timer = forceKillTimers.get(child)
        if (timer) clearTimeout(timer)
        forceKillTimers.delete(child)

        const closeHandler = closeHandlers.get(child)
        if (closeHandler) child.off("close", closeHandler)
        closeHandlers.delete(child)
    }

    function scheduleForceKill(child) {
        if (forceKillTimers.has(child)) return

        const closeHandler = () => clearForceKill(child)
        closeHandlers.set(child, closeHandler)
        child.once("close", closeHandler)

        const timer = setTimeout(() => {
            forceKillTimers.delete(child)
            terminateChild(child, "SIGKILL")
        }, forceKillAfterMs)
        timer.unref()
        forceKillTimers.set(child, timer)
    }

    for (const signal of Object.keys(signalExitCodes)) {
        handlers[signal] = () => {
            onSignal(signal)
            for (const child of activeChildren) {
                terminateChild(child, signal)
                scheduleForceKill(child)
            }
        }
        process.on(signal, handlers[signal])
    }

    return () => {
        for (const [signal, handler] of Object.entries(handlers)) {
            process.off(signal, handler)
        }
        for (const child of [...forceKillTimers.keys()]) clearForceKill(child)
    }
}

async function main(argv = process.argv.slice(2), options = {}) {
    const cwd = options.cwd ?? projectRoot
    const writeOutput = options.writeOutput ?? (value => process.stdout.write(value))
    const writeError = options.writeError ?? (value => process.stderr.write(value))
    const activeChildren = new Set()
    let interruptedBy = null
    let removeSignalHandlers = () => {}

    try {
        const parsed = parseArguments(argv)
        let requestedGroups

        if (parsed.mode === "group") {
            requestedGroups = [parsed.group]
        } else {
            const files = parsed.mode === "changed"
                ? getChangedFiles({ cwd, base: parsed.base })
                : parsed.files.map(file => path.isAbsolute(file) ? path.relative(cwd, file) : file)
            if (parsed.mode === "changed" && files.length === 0) {
                writeOutput("no changes\n")
                return 0
            }
            requestedGroups = selectTestGroups(files)
        }

        expandGroupNames(requestedGroups)
        writeOutput(`Groups: ${requestedGroups.join(", ")}\n`)
        removeSignalHandlers = installSignalHandlers(activeChildren, signal => {
            interruptedBy = signal
        })
        const report = await executeTestGroups(requestedGroups, {
            activeChildren,
            cwd,
            shouldStop: () => interruptedBy !== null,
            writeOutput,
        })
        return interruptedBy ? signalExitCodes[interruptedBy] : report.exitCode
    } catch (error) {
        writeError(`${error.message}\n`)
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
    executeTestGroups,
    expandGroupNames,
    getChangedFiles,
    hasExplicitSkipOutput,
    installSignalHandlers,
    main,
    mergeChangedFiles,
    parseArguments,
    summarizeResults,
}
