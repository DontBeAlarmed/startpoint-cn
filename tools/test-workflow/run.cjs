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
            if (!value || value.startsWith("-")) throw new Error("--base requires a git ref")
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

function buildGitCommands(base = null) {
    const commands = [
        ["diff", "--name-only", "--cached", "--"],
        ["diff", "--name-only", "--"],
        ["ls-files", "--others", "--exclude-standard", "--"],
    ]
    if (base !== null) commands.push(["diff", "--name-only", `${base}...HEAD`, "--"])
    return commands
}

function getChangedFiles({ cwd = projectRoot, base = null } = {}) {
    const fileLists = buildGitCommands(base).map(args => readGitFileList(args, cwd))
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

function parseTapSkipCounts(output) {
    const lines = output.split(/\r?\n/)
    let totalCases = null
    let skippedCases = null

    for (const line of lines) {
        const totalMatch = line.match(/^\s*#\s*tests\s+(\d+)\s*$/i)
        if (totalMatch) totalCases = Number(totalMatch[1])
        const skippedMatch = line.match(/^\s*#\s*skipped\s+(\d+)\s*$/i)
        if (skippedMatch) skippedCases = Number(skippedMatch[1])
    }

    const resultLines = lines.filter(line => /^(?:ok|not ok)\s+\d+\b/i.test(line))
    const inlineSkippedCases = resultLines.filter(line => /#\s*SKIP(?:\s|$)/i.test(line)).length
    const isTap = /^TAP version\s+\d+/m.test(output)
        || totalCases !== null
        || skippedCases !== null
        || resultLines.length > 0
    if (!isTap) return null

    return {
        totalCases: totalCases ?? resultLines.length,
        skippedCases: skippedCases ?? inlineSkippedCases,
    }
}

function hasExplicitWholeFileSkip(output) {
    return output.split(/\r?\n/).some(line => {
        if (/^\s*\d+\s+tests?\s+(?:were\s+)?skipped\b/i.test(line)) return false
        return /\btests?\s+(?:were\s+)?skipped(?:\s*:|$)/i.test(line)
            || /^\s*skip(?:ped)?(?:\s*:|\s+-)\s*\S/i.test(line)
            || /^\s*跳过(?:\s*:|：|\s+-)\s*\S/.test(line)
            || /(?:测试.*跳过|跳过.*测试)/.test(line)
    })
}

function classifyTestOutput(exitCode, output, { timedOut = false } = {}) {
    const tapCounts = parseTapSkipCounts(output)
    const skippedCases = tapCounts?.skippedCases
        ?? (hasExplicitWholeFileSkip(output) ? 1 : 0)

    if (timedOut || exitCode !== 0) return { status: "failed", skippedCases }
    if (tapCounts && tapCounts.totalCases > 0 && skippedCases >= tapCounts.totalCases) {
        return { status: "skipped", skippedCases }
    }
    if (!tapCounts && skippedCases > 0) return { status: "skipped", skippedCases }
    return { status: "passed", skippedCases }
}

function hasExplicitSkipOutput(output) {
    return classifyTestOutput(0, output).status === "skipped"
}

function terminateProcessGroup(child, processGroupId, signal) {
    if (!processGroupId) return
    try {
        if (process.platform === "win32") child.kill(signal)
        else process.kill(-processGroupId, signal)
    } catch (error) {
        if (error.code !== "ESRCH") throw error
    }
}

function runTestFile({ cwd, file, group, activeChildren, forceKillAfterMs, timeoutMs }) {
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
        const processGroupId = child.pid
        activeChildren.add(child)

        let stdout = ""
        let stderr = ""
        let timedOut = false
        let forceKillTimer = null
        let forceKillAttempted = false
        let closeResult = null
        let resolved = false

        function finishIfReady() {
            if (resolved || closeResult === null || (timedOut && !forceKillAttempted)) return
            resolved = true
            clearTimeout(timeout)
            activeChildren.delete(child)
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
            const output = `${stdout}${stderr}`
            const classification = classifyTestOutput(closeResult.exitCode, output, { timedOut })

            resolve({
                durationMs,
                exitCode: closeResult.exitCode,
                file,
                group,
                output,
                signal: closeResult.signal,
                ...classification,
                timedOut,
            })
        }

        const timeout = setTimeout(() => {
            timedOut = true
            stderr += `test timed out after ${timeoutMs}ms\n`
            try {
                terminateProcessGroup(child, processGroupId, "SIGTERM")
            } catch (error) {
                stderr += `failed to terminate process group: ${error.message}\n`
            }
            forceKillTimer = setTimeout(() => {
                try {
                    terminateProcessGroup(child, processGroupId, "SIGKILL")
                } catch (error) {
                    stderr += `failed to kill process group: ${error.message}\n`
                } finally {
                    forceKillAttempted = true
                    forceKillTimer = null
                    finishIfReady()
                }
            }, forceKillAfterMs)
        }, timeoutMs)
        child.stdout.on("data", chunk => { stdout += chunk })
        child.stderr.on("data", chunk => { stderr += chunk })

        child.on("error", error => {
            stderr += `${error.stack || error.message}\n`
        })

        child.on("close", (exitCode, signal) => {
            closeResult = { exitCode, signal }
            if (!timedOut && forceKillTimer === null) clearTimeout(timeout)
            finishIfReady()
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
            if (result.status === "passed") summary.passed++
            if (result.status === "failed") summary.failed++
            summary.skipped += result.skippedCases
                ?? (result.status === "skipped" ? 1 : 0)
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

    if (leafNames.length === 1 && testGroups[leafNames[0]].tests.length === 0) {
        throw new Error(`group ${leafNames[0]} has no tests configured`)
    }

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
                skippedCases: 1,
            })
            continue
        }

        const destination = definition.execution === "parallel" ? parallelItems : serialItems
        const timeoutMs = definition.timeoutMs
            ?? (definition.execution === "parallel" ? 30000 : 120000)
        const forceKillAfterMs = definition.forceKillAfterMs ?? 2000
        for (const file of definition.tests) {
            destination.push({ file, forceKillAfterMs, group, timeoutMs })
        }
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
    const sendSignal = options.sendSignal ?? terminateProcessGroup
    const onSignalError = options.onSignalError ?? ((error, context) => {
        process.stderr.write(
            `failed to signal process group ${context.processGroupId} with ${context.signal}: ${error.message}\n`,
        )
    })

    function safelySendSignal(child, processGroupId, signal) {
        try {
            sendSignal(child, processGroupId, signal)
        } catch (error) {
            if (error.code === "ESRCH") return
            try {
                onSignalError(error, { processGroupId, signal })
            } catch {}
        }
    }

    function scheduleForceKill(child) {
        const processGroupId = child.pid
        if (!processGroupId || forceKillTimers.has(processGroupId)) return

        let resolveForceKill
        const completion = new Promise(resolve => { resolveForceKill = resolve })
        const timer = setTimeout(() => {
            try {
                safelySendSignal(child, processGroupId, "SIGKILL")
            } finally {
                forceKillTimers.delete(processGroupId)
                resolveForceKill()
            }
        }, forceKillAfterMs)
        forceKillTimers.set(processGroupId, { completion, timer })
    }

    for (const signal of Object.keys(signalExitCodes)) {
        handlers[signal] = () => {
            onSignal(signal)
            for (const child of activeChildren) {
                try {
                    safelySendSignal(child, child.pid, signal)
                } finally {
                    scheduleForceKill(child)
                }
            }
        }
        process.on(signal, handlers[signal])
    }

    return async () => {
        for (const [signal, handler] of Object.entries(handlers)) {
            process.off(signal, handler)
        }
        await Promise.all([...forceKillTimers.values()].map(entry => entry.completion))
    }
}

async function main(argv = process.argv.slice(2), options = {}) {
    const cwd = options.cwd ?? projectRoot
    const writeOutput = options.writeOutput ?? (value => process.stdout.write(value))
    const writeError = options.writeError ?? (value => process.stderr.write(value))
    const activeChildren = new Set()
    let interruptedBy = null
    let removeSignalHandlers = async () => {}

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
        await removeSignalHandlers()
    }
}

if (require.main === module) {
    main().then(exitCode => {
        process.exitCode = exitCode
    })
}

module.exports = {
    buildGitCommands,
    classifyTestOutput,
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
