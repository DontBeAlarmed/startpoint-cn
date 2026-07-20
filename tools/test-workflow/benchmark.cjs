#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process")
const { createHash, randomUUID } = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "../..")
const signalExitCodes = { SIGINT: 130, SIGTERM: 143 }
const MAX_OUTPUT_BYTES = 1024 * 1024

const DEFAULT_COMMANDS = Object.freeze([
    Object.freeze({
        args: ["tools/test-workflow/run.cjs", "--group", "quick"],
        command: "node tools/test-workflow/run.cjs --group quick",
        executable: process.execPath,
        name: "test:quick",
        thresholdMs: 5000,
        timeoutMs: 30000,
    }),
    Object.freeze({
        args: ["tools/test-workflow/run.cjs", "--files", "src/routes/api/singleBattleQuest.ts"],
        command: "node tools/test-workflow/run.cjs --files src/routes/api/singleBattleQuest.ts",
        executable: process.execPath,
        name: "test:changed",
        thresholdMs: 20000,
        timeoutMs: 60000,
    }),
    Object.freeze({
        args: ["tools/test-workflow/run.cjs", "--group", "integration"],
        command: "node tools/test-workflow/run.cjs --group integration",
        executable: process.execPath,
        name: "test:integration",
        thresholdMs: 30000,
        timeoutMs: 90000,
    }),
    Object.freeze({
        args: ["tools/test-workflow/run.cjs", "--group", "full"],
        command: "node tools/test-workflow/run.cjs --group full",
        executable: process.execPath,
        name: "test:full",
        thresholdMs: 60000,
        timeoutMs: 120000,
    }),
    Object.freeze({
        args: ["--max-old-space-size=4096", "node_modules/typescript/bin/tsc", "--noEmit"],
        command: "node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit",
        executable: process.execPath,
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

function createTailBuffer(maxBytes = MAX_OUTPUT_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
        throw new TypeError("output capture limit must be a positive integer")
    }
    const storage = Buffer.allocUnsafe(maxBytes)
    let start = 0
    let length = 0
    let truncated = false

    return {
        append(value) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
            if (chunk.length === 0) return
            if (chunk.length >= maxBytes) {
                truncated ||= length > 0 || chunk.length > maxBytes
                chunk.copy(storage, 0, chunk.length - maxBytes)
                start = 0
                length = maxBytes
                return
            }

            if (length + chunk.length > maxBytes) {
                truncated = true
                const discardedBytes = length + chunk.length - maxBytes
                start = (start + discardedBytes) % maxBytes
                length -= discardedBytes
            }

            const end = (start + length) % maxBytes
            const firstCopyBytes = Math.min(chunk.length, maxBytes - end)
            chunk.copy(storage, end, 0, firstCopyBytes)
            if (firstCopyBytes < chunk.length) {
                chunk.copy(storage, 0, firstCopyBytes)
            }
            length += chunk.length
        },
        get outputTruncated() {
            return truncated
        },
        get storageBytes() {
            return storage.length
        },
        get storageSegments() {
            return 1
        },
        toString() {
            if (length === 0) return ""
            if (start + length <= maxBytes) {
                return storage.subarray(start, start + length).toString("utf8")
            }
            const firstPart = storage.subarray(start)
            const secondPart = storage.subarray(0, length - firstPart.length)
            return Buffer.concat([firstPart, secondPart], length).toString("utf8")
        },
    }
}

function normalizeProcessIdentity(identity) {
    return typeof identity === "string" ? identity.trim().replace(/\s+/g, " ") : null
}

function readPosixProcessTable(options = {}) {
    if (options.readProcessTable) return options.readProcessTable()
    const spawnSyncImpl = options.spawnSync ?? spawnSync
    const result = spawnSyncImpl(
        "ps",
        ["-axo", "pid=,ppid=,pgid=,lstart="],
        { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 1000 },
    )
    if (result.error) throw result.error
    if (result.status !== 0) {
        throw new Error(result.stderr?.trim() || `ps exited with status ${result.status}`)
    }
    return result.stdout.split(/\r?\n/).flatMap(line => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/)
        if (!match) return []
        return [{
            identity: normalizeProcessIdentity(match[4]),
            pgid: Number(match[3]),
            pid: Number(match[1]),
            ppid: Number(match[2]),
        }]
    })
}

function capturePosixTerminationTargets(activeRun, options = {}) {
    if (activeRun.terminationTargets) return activeRun.terminationTargets
    let processTable = []
    try {
        processTable = readPosixProcessTable(options)
    } catch (error) {
        recordLifecycleError(activeRun, "failed to read POSIX process tree", error)
    }

    const normalizedTable = processTable.map(entry => ({
        identity: normalizeProcessIdentity(entry.identity),
        pgid: Number(entry.pgid),
        pid: Number(entry.pid),
        ppid: Number(entry.ppid),
    })).filter(entry => [entry.pid, entry.ppid, entry.pgid].every(Number.isInteger))
    const processesByPid = new Map(normalizedTable.map(entry => [entry.pid, entry]))
    const childrenByParent = new Map()
    for (const entry of normalizedTable) {
        const children = childrenByParent.get(entry.ppid) ?? []
        children.push(entry.pid)
        childrenByParent.set(entry.ppid, children)
    }

    const rootPid = activeRun.processId ?? activeRun.processGroupId
    const rootEntry = processesByPid.get(rootPid) ?? {
        identity: null,
        pgid: activeRun.processGroupId,
        pid: rootPid,
        ppid: 0,
    }
    const currentPid = options.currentPid ?? process.pid
    const currentProcessGroupId = processesByPid.get(currentPid)?.pgid
        ?? options.currentProcessGroupId
        ?? null
    const capturedProcesses = []
    const seen = new Set()

    function visit(entry, depth) {
        if (!entry || seen.has(entry.pid)) return
        seen.add(entry.pid)
        capturedProcesses.push({ ...entry, depth })
        for (const childPid of childrenByParent.get(entry.pid) ?? []) {
            visit(processesByPid.get(childPid), depth + 1)
        }
    }
    visit(rootEntry, 0)
    activeRun.capturedProcesses = capturedProcesses
        .filter(entry => entry.pid > 0 && entry.pid !== currentPid)
        .sort((left, right) => right.depth - left.depth || left.pid - right.pid)

    const groupDepths = new Map()
    const pidTargets = []
    for (const entry of capturedProcesses) {
        const isKnownSafeGroup = entry.pgid > 0 && (
            (currentProcessGroupId !== null && entry.pgid !== currentProcessGroupId)
            || (entry.pid === rootPid && entry.pgid === activeRun.processGroupId)
        )
        if (isKnownSafeGroup) {
            groupDepths.set(entry.pgid, Math.max(groupDepths.get(entry.pgid) ?? -1, entry.depth))
        } else if (entry.pid > 0 && entry.pid !== currentPid) {
            pidTargets.push({ depth: entry.depth, id: entry.pid, type: "pid" })
        }
    }
    const groupTargets = [...groupDepths].map(([id, depth]) => ({ depth, id, type: "group" }))
    activeRun.terminationTargets = [...groupTargets, ...pidTargets]
        .sort((left, right) => right.depth - left.depth || left.id - right.id)
    return activeRun.terminationTargets
}

function signalPosixProcessTree(activeRun, signal, options = {}) {
    const killProcess = options.killProcess ?? process.kill.bind(process)
    for (const target of capturePosixTerminationTargets(activeRun, options)) {
        const processTarget = target.type === "group" ? -target.id : target.id
        try {
            killProcess(processTarget, signal)
        } catch (error) {
            recordLifecycleError(
                activeRun,
                `failed to signal ${target.type} ${target.id} with ${signal}`,
                error,
            )
        }
    }
}

function forceKillCapturedPosixProcesses(activeRun, options = {}) {
    capturePosixTerminationTargets(activeRun, options)
    let currentProcessTable
    try {
        currentProcessTable = readPosixProcessTable(options)
    } catch (error) {
        recordLifecycleError(activeRun, "failed to verify POSIX process identities", error)
        return
    }
    const currentProcesses = new Map(currentProcessTable.map(entry => [Number(entry.pid), {
        identity: normalizeProcessIdentity(entry.identity),
        pid: Number(entry.pid),
    }]))
    const killProcess = options.killProcess ?? process.kill.bind(process)

    for (const capturedProcess of activeRun.capturedProcesses ?? []) {
        const currentProcess = currentProcesses.get(capturedProcess.pid)
        if (!capturedProcess.identity || currentProcess?.identity !== capturedProcess.identity) continue
        try {
            killProcess(capturedProcess.pid, "SIGKILL")
        } catch (error) {
            recordLifecycleError(
                activeRun,
                `failed to force-kill pid ${capturedProcess.pid}`,
                error,
            )
        }
    }
}

function taskkillProcessTree(activeRun, options = {}) {
    const spawnSyncImpl = options.spawnSync ?? spawnSync
    const args = ["/PID", String(activeRun.processGroupId), "/T", "/F"]
    const result = spawnSyncImpl("taskkill", args, {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: 5000,
        windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
        throw new Error(result.stderr?.trim() || `taskkill exited with status ${result.status}`)
    }
}

function signalProcessTree(activeRun, signal, options = {}) {
    if (!activeRun?.processGroupId) return
    const platform = options.platform ?? process.platform
    if (platform === "win32") {
        taskkillProcessTree(activeRun, options)
        return
    }
    signalPosixProcessTree(activeRun, signal, options)
}

function forceKillProcessTree(activeRun, options = {}) {
    if (!activeRun?.processGroupId) return
    const platform = options.platform ?? process.platform
    if (platform === "win32") return
    forceKillCapturedPosixProcesses(activeRun, options)
}

function recordLifecycleError(activeRun, context, error) {
    if (error?.code === "ESRCH") return
    activeRun.cleanupErrors ??= []
    activeRun.cleanupErrors.push(`${context}: ${error?.message ?? String(error)}`)
}

function safelySignalProcessTree(activeRun, signal, options = {}) {
    try {
        signalProcessTree(activeRun, signal, options)
        return true
    } catch (error) {
        recordLifecycleError(activeRun, `failed to signal process tree with ${signal}`, error)
        activeRun.handleCleanupFailure?.()
        return false
    }
}

function scheduleForceKill(activeRun, options = {}) {
    if (activeRun.cleanupPromise) return activeRun.cleanupPromise
    const forceKillAfterMs = options.forceKillAfterMs ?? 2000
    const setTimeoutImpl = options.setTimeout ?? setTimeout
    let resolveCleanup
    activeRun.cleanupPromise = new Promise(resolve => { resolveCleanup = resolve })
    try {
        activeRun.cleanupTimer = setTimeoutImpl(() => {
            activeRun.cleanupTimer = null
            try {
                forceKillProcessTree(activeRun, options)
            } catch (error) {
                recordLifecycleError(activeRun, "failed to force-kill process tree", error)
            } finally {
                resolveCleanup()
            }
        }, forceKillAfterMs)
    } catch (error) {
        recordLifecycleError(activeRun, "failed to schedule process-tree cleanup", error)
        resolveCleanup()
    }
    return activeRun.cleanupPromise
}

function runCommand(command, state, options = {}) {
    const cwd = options.cwd ?? projectRoot
    const platform = options.platform ?? process.platform
    const executable = command.executable ?? process.execPath
    const spawnImpl = options.spawn ?? spawn
    const setTimeoutImpl = options.setTimeout ?? setTimeout
    const clearTimeoutImpl = options.clearTimeout ?? clearTimeout
    const now = options.now ?? (() => Number(process.hrtime.bigint()) / 1e6)
    const outputBuffer = createTailBuffer(options.maxOutputBytes ?? MAX_OUTPUT_BYTES)

    return new Promise(resolve => {
        const startedAt = now()
        const child = spawnImpl(executable, command.args, {
            cwd,
            detached: platform !== "win32",
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        })
        const activeRun = {
            child,
            capturedProcesses: null,
            cleanupErrors: [],
            cleanupPromise: null,
            cleanupTimer: null,
            processId: child.pid ?? null,
            processGroupId: child.pid ?? null,
            terminationTargets: null,
            timeoutTimer: null,
            windowsFallbackTimer: null,
        }
        state.activeRun = activeRun

        let timedOut = false
        let spawnError = null
        let childHandlesReleased = false
        let finalizing = false
        let resolved = false

        function releaseFailedWindowsChildHandles() {
            if (childHandlesReleased) return
            childHandlesReleased = true

            child.stdout?.removeListener("data", handleStdoutData)
            child.stderr?.removeListener("data", handleStderrData)
            child.removeListener("error", handleChildError)
            child.removeListener("close", handleChildClose)

            for (const [name, stream] of [
                ["stdin", child.stdin],
                ["stdout", child.stdout],
                ["stderr", child.stderr],
            ]) {
                try {
                    stream?.destroy()
                } catch (error) {
                    recordLifecycleError(activeRun, `failed to destroy child ${name}`, error)
                }
            }
            try {
                child.unref?.()
            } catch (error) {
                recordLifecycleError(activeRun, "failed to unref child process", error)
            }
            activeRun.child = null
        }

        async function finalize(exitCode, signal, finalizeOptions = {}) {
            if (finalizing || resolved) return
            finalizing = true
            if (activeRun.timeoutTimer !== null) {
                clearTimeoutImpl(activeRun.timeoutTimer)
                activeRun.timeoutTimer = null
            }
            if (activeRun.windowsFallbackTimer !== null) {
                clearTimeoutImpl(activeRun.windowsFallbackTimer)
                activeRun.windowsFallbackTimer = null
            }
            if (activeRun.cleanupPromise) await activeRun.cleanupPromise
            if (finalizeOptions.releaseFailedWindowsChild === true) {
                releaseFailedWindowsChildHandles()
            }
            if (activeRun.cleanupErrors.length > 0) {
                outputBuffer.append(`${activeRun.cleanupErrors.join("\n")}\n`)
            }
            if (state.activeRun === activeRun) state.activeRun = null

            const durationMs = now() - startedAt
            const output = outputBuffer.toString()
            const summary = parseRunnerSummary(output) ?? { failed: 0, passed: 0, skipped: 0 }
            const result = {
                cleanupError: activeRun.cleanupErrors.length > 0,
                durationMs,
                failed: summary.failed,
                output,
                outputTruncated: outputBuffer.outputTruncated,
                passed: summary.passed,
                rawExitCode: exitCode,
                signal,
                skipped: summary.skipped,
                spawnError: spawnError?.message ?? null,
                timedOut,
            }
            resolved = true
            resolve(result)
        }

        activeRun.handleCleanupFailure = () => {
            if (platform !== "win32" || finalizing || resolved) return
            if (activeRun.windowsFallbackTimer !== null) return
            try {
                const killed = child.kill("SIGKILL")
                if (killed === false) {
                    recordLifecycleError(activeRun, "failed to force-kill root process", new Error("child.kill returned false"))
                }
            } catch (error) {
                recordLifecycleError(activeRun, "failed to force-kill root process", error)
            }

            const fallbackAfterMs = options.windowsFallbackAfterMs ?? 1000
            try {
                activeRun.windowsFallbackTimer = setTimeoutImpl(() => {
                    activeRun.windowsFallbackTimer = null
                    void finalize(null, null, { releaseFailedWindowsChild: true })
                }, fallbackAfterMs)
            } catch (error) {
                recordLifecycleError(activeRun, "failed to schedule Windows cleanup fallback", error)
                void finalize(null, null, { releaseFailedWindowsChild: true })
            }
        }

        function handleStdoutData(chunk) {
            outputBuffer.append(chunk)
        }

        function handleStderrData(chunk) {
            outputBuffer.append(chunk)
        }

        function handleChildError(error) {
            spawnError = error
            outputBuffer.append(`${error.stack || error.message}\n`)
        }

        function handleChildClose(exitCode, signal) {
            void finalize(exitCode, signal)
        }

        activeRun.timeoutTimer = setTimeoutImpl(() => {
            timedOut = true
            outputBuffer.append(`\nbenchmark timeout after ${command.timeoutMs}ms\n`)
            safelySignalProcessTree(activeRun, "SIGTERM", { ...options, platform })
            if (platform !== "win32") {
                scheduleForceKill(activeRun, { ...options, platform })
            }
        }, command.timeoutMs)

        child.stdout.on("data", handleStdoutData)
        child.stderr.on("data", handleStderrData)
        child.on("error", handleChildError)
        child.on("close", handleChildClose)
    })
}

function rawExitCodeForEvaluation(run) {
    return run.rawExitCode === 0
        && !run.timedOut
        && run.spawnError === null
        && run.cleanupError !== true
        ? 0
        : 1
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
        cleanupError: run.cleanupError ?? false,
        durationMs: roundMilliseconds(run.durationMs),
        failed: run.failed,
        outputTruncated: run.outputTruncated ?? false,
        passed: run.passed,
        rawExitCode: run.rawExitCode,
        signal: run.signal,
        skipped: run.skipped,
        timedOut: run.timedOut,
    }
}

function buildCommandReport(command, warmup, runs, options = {}) {
    const rawDurationsMs = runs.map(run => run.durationMs)
    const cleanupFailed = [warmup, ...runs].some(run => run.cleanupError === true)
    const rawMedianMs = rawDurationsMs.length === 0 ? null : median(rawDurationsMs)
    const commandExitCodes = [warmup, ...runs].map(rawExitCodeForEvaluation)
    const evaluation = cleanupFailed
        ? {
            commandSucceeded: false,
            exitCode: 1,
            withinThreshold: null,
        }
        : evaluateThreshold({
            commandExitCodes,
            medianMs: rawMedianMs,
            reportOnly: options.reportOnly ?? false,
            thresholdMs: command.thresholdMs,
        })
    const counts = latestCounts(runs.length === 0 ? [warmup] : runs)
    let status
    if (cleanupFailed) {
        status = "cleanup-failed"
    } else if (!evaluation.commandSucceeded) {
        status = "command-failed"
    } else {
        status = evaluation.withinThreshold ? "passed" : "threshold-exceeded"
    }

    return {
        aborted: cleanupFailed,
        command: command.command,
        commandSucceeded: evaluation.commandSucceeded,
        durationsMs: rawDurationsMs.map(roundMilliseconds),
        exitCode: evaluation.exitCode,
        failed: counts.failed,
        medianMs: cleanupFailed || rawMedianMs === null ? null : roundMilliseconds(rawMedianMs),
        name: command.name,
        outputTruncated: [warmup, ...runs].some(run => run.outputTruncated === true),
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

async function benchmarkCommand(command, state, options = {}) {
    const writeStatus = options.writeStatus ?? (value => process.stderr.write(value))
    const runCommandImpl = options.runCommand ?? runCommand
    writeStatus(`[benchmark] ${command.name}: warm-up\n`)
    const warmup = await runCommandImpl(command, state, options)
    const runs = []
    if (warmup.cleanupError === true) {
        return buildCommandReport(command, warmup, runs, options)
    }

    for (let attempt = 1; attempt <= 3 && state.interruptedBy === null; attempt++) {
        writeStatus(`[benchmark] ${command.name}: run ${attempt}/3\n`)
        const run = await runCommandImpl(command, state, options)
        runs.push(run)
        if (run.cleanupError === true) break
    }

    if (runs.length !== 3 && !runs.some(run => run.cleanupError === true)) return null
    return buildCommandReport(command, warmup, runs, options)
}

function readCommit(cwd) {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr.trim() || "git rev-parse HEAD failed")
    return result.stdout.trim()
}

function summarizeWorkingTreeStatus(statusOutput) {
    if (!Buffer.isBuffer(statusOutput)) {
        throw new TypeError("working tree status must be a Buffer")
    }

    let trackedChanges = 0
    let untrackedFiles = 0
    let offset = 0
    while (offset < statusOutput.length) {
        const terminator = statusOutput.indexOf(0, offset)
        if (terminator === -1 || terminator - offset < 3) {
            throw new Error("invalid git porcelain status output")
        }

        const indexStatus = statusOutput[offset]
        const workTreeStatus = statusOutput[offset + 1]
        if (indexStatus === 0x3f && workTreeStatus === 0x3f) untrackedFiles++
        else trackedChanges++

        offset = terminator + 1
        const isRenameOrCopy = [indexStatus, workTreeStatus]
            .some(status => status === 0x52 || status === 0x43)
        if (isRenameOrCopy) {
            const sourceTerminator = statusOutput.indexOf(0, offset)
            if (sourceTerminator === -1) throw new Error("invalid git rename status output")
            offset = sourceTerminator + 1
        }
    }

    return {
        dirty: statusOutput.length > 0,
        statusSha256: createHash("sha256").update(statusOutput).digest("hex"),
        trackedChanges,
        untrackedFiles,
    }
}

function readWorkingTree(cwd, options = {}) {
    const spawnSyncImpl = options.spawnSync ?? spawnSync
    const result = spawnSyncImpl(
        "git",
        ["status", "--porcelain=v1", "-z"],
        { cwd, maxBuffer: 2 * 1024 * 1024 },
    )
    if (result.error) throw result.error
    if (result.status !== 0) {
        const message = Buffer.isBuffer(result.stderr)
            ? result.stderr.toString("utf8").trim()
            : String(result.stderr ?? "").trim()
        throw new Error(message || "git status --porcelain failed")
    }
    const statusOutput = Buffer.isBuffer(result.stdout)
        ? result.stdout
        : Buffer.from(result.stdout ?? "")
    return summarizeWorkingTreeStatus(statusOutput)
}

function writeReport(report, outputPath, cwd, options = {}) {
    const fsImpl = options.fs ?? fs
    const createUniqueId = options.randomUUID ?? randomUUID
    const writeOutput = options.writeOutput ?? (value => process.stdout.write(value))
    const serialized = `${JSON.stringify(report, null, 2)}\n`
    if (outputPath === null) {
        writeOutput(serialized)
        return
    }

    const resolvedPath = path.resolve(cwd, outputPath)
    const outputDirectory = path.dirname(resolvedPath)
    const temporaryPath = path.join(
        outputDirectory,
        `.${path.basename(resolvedPath)}.${process.pid}.${createUniqueId()}.tmp`,
    )
    fsImpl.mkdirSync(outputDirectory, { recursive: true })

    let failure = null
    try {
        fsImpl.writeFileSync(temporaryPath, serialized, { encoding: "utf8", flag: "wx" })
        fsImpl.renameSync(temporaryPath, resolvedPath)
    } catch (error) {
        failure = error
    } finally {
        try {
            fsImpl.unlinkSync(temporaryPath)
        } catch (error) {
            if (error.code !== "ENOENT" && failure === null) failure = error
        }
    }
    if (failure !== null) throw failure
    writeOutput(`benchmark report: ${resolvedPath}\n`)
}

function installSignalHandlers(state, options = {}) {
    const processTarget = options.processTarget ?? process
    const platform = options.platform ?? process.platform
    const signalTree = options.signalProcessTree
        ?? ((activeRun, signal) => safelySignalProcessTree(activeRun, signal, options))
    const scheduleKill = options.scheduleForceKill
        ?? (activeRun => scheduleForceKill(activeRun, options))
    const handlers = {}
    const cleanupPromises = new Set()

    for (const signal of Object.keys(signalExitCodes)) {
        handlers[signal] = () => {
            if (state.interruptedBy !== null) return
            state.interruptedBy = signal
            const activeRun = state.activeRun
            if (!activeRun) return
            try {
                signalTree(activeRun, "SIGTERM")
            } catch (error) {
                recordLifecycleError(activeRun, `failed to signal process tree with ${signal}`, error)
                activeRun.handleCleanupFailure?.()
            }
            if (platform !== "win32") {
                try {
                    const cleanupPromise = scheduleKill(activeRun)
                    cleanupPromises.add(cleanupPromise)
                    cleanupPromise.then(
                        () => cleanupPromises.delete(cleanupPromise),
                        () => cleanupPromises.delete(cleanupPromise),
                    )
                } catch (error) {
                    recordLifecycleError(activeRun, "failed to schedule process-tree cleanup", error)
                }
            }
        }
        processTarget.on(signal, handlers[signal])
    }

    return async () => {
        for (const [signal, handler] of Object.entries(handlers)) {
            processTarget.off(signal, handler)
        }
        await Promise.allSettled([...cleanupPromises])
    }
}

async function main(argv = process.argv.slice(2), options = {}) {
    const cwd = options.cwd ?? projectRoot
    const writeError = options.writeError ?? (value => process.stderr.write(value))
    const commandsToBenchmark = options.commands ?? DEFAULT_COMMANDS
    const benchmarkCommandImpl = options.benchmarkCommand ?? benchmarkCommand
    const createDate = options.createDate ?? (() => new Date())
    const installSignalHandlersImpl = options.installSignalHandlers ?? installSignalHandlers
    const readCommitImpl = options.readCommit ?? readCommit
    const readWorkingTreeImpl = options.readWorkingTree ?? readWorkingTree
    const writeReportImpl = options.writeReport ?? writeReport
    const state = { activeRun: null, interruptedBy: null }
    let removeSignalHandlers = async () => {}

    try {
        const parsed = parseArguments(argv)
        const commands = parsed.only === null
            ? commandsToBenchmark
            : commandsToBenchmark.filter(command => command.name === parsed.only)
        if (commands.length === 0) {
            throw new Error(`unknown benchmark command: ${parsed.only}`)
        }

        const report = {
            schemaVersion: 1,
            aborted: false,
            commit: readCommitImpl(cwd),
            nodeVersion: process.version,
            startedAt: createDate().toISOString(),
            status: "completed",
            workingTree: readWorkingTreeImpl(cwd),
            commands: [],
        }
        removeSignalHandlers = installSignalHandlersImpl(state, options)

        for (const command of commands) {
            if (state.interruptedBy !== null) break
            const result = await benchmarkCommandImpl(command, state, {
                ...options,
                reportOnly: parsed.reportOnly,
            })
            if (result !== null) {
                report.commands.push(result)
                if (result.aborted === true) {
                    report.aborted = true
                    report.status = result.status
                    break
                }
            }
        }

        if (state.interruptedBy !== null) return signalExitCodes[state.interruptedBy]
        writeReportImpl(report, parsed.output, cwd, options)
        return report.aborted || report.commands.some(command => command.exitCode !== 0) ? 1 : 0
    } catch (error) {
        writeError(`${error.stack || error.message}\n`)
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
    DEFAULT_COMMANDS,
    MAX_OUTPUT_BYTES,
    benchmarkCommand,
    buildCommandReport,
    createTailBuffer,
    evaluateThreshold,
    forceKillProcessTree,
    installSignalHandlers,
    main,
    median,
    parseArguments,
    parseRunnerSummary,
    runCommand,
    signalProcessTree,
    summarizeWorkingTreeStatus,
    writeReport,
}
