#!/usr/bin/env node
"use strict"

const fs = require("node:fs")
const { summarizeHttpSamples } = require("./http_metrics.cjs")

const DEFAULT_URL = "http://127.0.0.1:8001/healthz"
const DEFAULT_REQUESTS = 100
const DEFAULT_CONCURRENCY = 1
const DEFAULT_TIMEOUT_MS = 5000

function parsePositiveInteger(value, name) {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`)
    }
    return parsed
}

function parseArgs(argv) {
    const parsed = {
        concurrency: DEFAULT_CONCURRENCY,
        output: null,
        requests: DEFAULT_REQUESTS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        url: process.env.PERF_BASE_URL ?? DEFAULT_URL,
    }

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        const value = argv[++index]
        if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`)

        if (argument === "--url") parsed.url = value
        else if (argument === "--requests") parsed.requests = parsePositiveInteger(value, "requests")
        else if (argument === "--concurrency") parsed.concurrency = parsePositiveInteger(value, "concurrency")
        else if (argument === "--timeout-ms") parsed.timeoutMs = parsePositiveInteger(value, "timeout-ms")
        else if (argument === "--output") parsed.output = value
        else throw new Error(`unknown argument: ${argument}`)
    }

    try {
        parsed.url = new URL(parsed.url).toString()
    } catch {
        throw new Error("url must be a valid HTTP URL")
    }
    if (!/^https?:$/.test(new URL(parsed.url).protocol)) {
        throw new Error("url must use http or https")
    }
    return parsed
}

async function requestOnce({ fetchImpl, timeoutMs, url }) {
    const startedAt = performance.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetchImpl(url, { signal: controller.signal })
        await response.arrayBuffer()
        return { durationMs: performance.now() - startedAt, status: response.status }
    } catch (error) {
        return {
            durationMs: performance.now() - startedAt,
            error: error?.name === "AbortError" ? "timeout" : String(error?.message ?? error),
        }
    } finally {
        clearTimeout(timeout)
    }
}

async function runHttpBaseline({
    concurrency = DEFAULT_CONCURRENCY,
    fetchImpl = fetch,
    requests = DEFAULT_REQUESTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    url = DEFAULT_URL,
} = {}) {
    const workload = {
        concurrency: parsePositiveInteger(concurrency, "concurrency"),
        requests: parsePositiveInteger(requests, "requests"),
        timeoutMs: parsePositiveInteger(timeoutMs, "timeout-ms"),
        url: String(url),
    }
    const samples = []
    let nextIndex = 0
    const workerCount = Math.min(workload.concurrency, workload.requests)

    async function worker() {
        while (true) {
            const index = nextIndex++
            if (index >= workload.requests) return
            samples[index] = await requestOnce({ fetchImpl, timeoutMs: workload.timeoutMs, url: workload.url })
        }
    }

    const startedAt = new Date().toISOString()
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    return {
        startedAt,
        workload,
        summary: summarizeHttpSamples(samples),
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2))
    const report = await runHttpBaseline(options)
    const serialized = `${JSON.stringify(report, null, 2)}\n`
    if (options.output) fs.writeFileSync(options.output, serialized, "utf8")
    process.stdout.write(serialized)
    if (report.summary.errors > 0) process.exitCode = 1
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack ?? error}\n`)
        process.exitCode = 1
    })
}

module.exports = { parseArgs, requestOnce, runHttpBaseline }
