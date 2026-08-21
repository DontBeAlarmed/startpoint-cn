"use strict"

const { spawn } = require("node:child_process")

function validatePositiveSafeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`)
    }
}

function startOwnedProcess({
    command,
    args = [],
    cwd,
    timeoutMs,
    terminationTimeoutMs = 5_000,
    maxOutputBytes = 20 * 1024 * 1024,
    platform = process.platform,
    spawnProcess = spawn,
    killProcess = process.kill,
    now = Date.now,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    probeIntervalMs = 25,
}) {
    validatePositiveSafeInteger(timeoutMs, "timeoutMs")
    validatePositiveSafeInteger(terminationTimeoutMs, "terminationTimeoutMs")
    validatePositiveSafeInteger(maxOutputBytes, "maxOutputBytes")
    validatePositiveSafeInteger(probeIntervalMs, "probeIntervalMs")
    const detached = platform !== "win32"
    const child = spawnProcess(command, args, {
        cwd,
        detached,
        stdio: ["ignore", "pipe", "pipe"],
    })
    const ownedPgid = detached && Number.isSafeInteger(child.pid) && child.pid > 0
        ? child.pid
        : null
    let stdout = ""
    let stderr = ""
    let outputOverflow = false
    let terminal = false
    let cleanupPromise = null
    let resolveTerminal
    const terminalPromise = new Promise(resolve => { resolveTerminal = resolve })

    const append = (target, chunk) => {
        const next = target + chunk
        if (Buffer.byteLength(next) > maxOutputBytes) {
            outputOverflow = true
            return target
        }
        return next
    }
    const onStdout = chunk => { stdout = append(stdout, chunk) }
    const onStderr = chunk => { stderr = append(stderr, chunk) }
    const removeListeners = () => {
        child.off("close", onClose)
        child.off("error", onError)
        child.stdout?.off("data", onStdout)
        child.stderr?.off("data", onStderr)
    }
    const finish = outcome => {
        if (terminal) return
        terminal = true
        removeListeners()
        resolveTerminal(outcome)
    }
    const onClose = (code, signal) => finish({ code, signal })
    const onError = () => finish({ error: true })
    child.stdout?.on("data", onStdout)
    child.stderr?.on("data", onStderr)
    child.once("close", onClose)
    child.once("error", onError)

    const waitForTerminal = async waitMs => {
        if (terminal) return true
        let timer
        const result = await Promise.race([
            terminalPromise.then(() => true),
            new Promise(resolve => { timer = setTimeout(() => resolve(false), waitMs) }),
        ])
        clearTimeout(timer)
        return result
    }

    const signalGroup = signal => {
        if (ownedPgid === null) {
            return { error: new Error("owned process group id is unavailable"), gone: false }
        }
        try {
            killProcess(-ownedPgid, signal)
            return { error: null, gone: false }
        } catch (error) {
            if (error?.code === "ESRCH") return { error: null, gone: true }
            return { error, gone: false }
        }
    }

    const waitForGroupGone = async waitMs => {
        const deadline = now() + waitMs
        while (true) {
            const probe = signalGroup(0)
            if (probe.gone || probe.error) return probe
            const remainingMs = deadline - now()
            if (remainingMs <= 0) return { error: null, gone: false }
            await sleep(Math.min(probeIntervalMs, remainingMs))
        }
    }

    const cleanup = () => {
        if (cleanupPromise) return cleanupPromise
        cleanupPromise = (async () => {
            const errors = []
            if (detached) {
                const term = signalGroup("SIGTERM")
                let groupState = term.gone
                    ? term
                    : await waitForGroupGone(terminationTimeoutMs)
                let groupError = term.error ?? groupState.error
                if (!groupState.gone) {
                    const kill = signalGroup("SIGKILL")
                    groupError ??= kill.error
                    groupState = kill.gone
                        ? kill
                        : await waitForGroupGone(terminationTimeoutMs)
                    groupError ??= groupState.error
                }
                if (!groupState.gone) {
                    if (groupError) errors.push(groupError)
                    errors.push(new Error("owned process group did not stop"))
                }
            } else if (!terminal) {
                try {
                    child.kill("SIGTERM")
                } catch (error) {
                    errors.push(error)
                }
                if (!await waitForTerminal(terminationTimeoutMs)) {
                    try {
                        child.kill("SIGKILL")
                    } catch (error) {
                        errors.push(error)
                    }
                }
            }
            if (!terminal && !await waitForTerminal(terminationTimeoutMs)) {
                errors.push(new Error("owned direct process did not stop"))
            }
            removeListeners()
            if (errors.length > 0) {
                throw new AggregateError(errors, "owned process cleanup failed", {
                    cause: errors[0],
                })
            }
        })()
        return cleanupPromise
    }

    const result = (async () => {
        let timer
        const outcome = await Promise.race([
            terminalPromise,
            new Promise(resolve => {
                timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
            }),
        ])
        clearTimeout(timer)
        if (outcome.timedOut) {
            await cleanup()
            throw new Error("owned process timed out")
        }
        if (outcome.error) throw new Error("owned process failed to start")
        if (outputOverflow) throw new Error("owned process output exceeded its limit")
        return { code: outcome.code, signal: outcome.signal, stderr, stdout }
    })()

    return { child, cleanup, result }
}

module.exports = { startOwnedProcess }
