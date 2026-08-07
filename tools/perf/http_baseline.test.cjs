"use strict"

const assert = require("node:assert/strict")
const http = require("node:http")
const test = require("node:test")

const { parseArgs, runHttpBaseline } = require("./http_baseline.cjs")

test("validates fixed-request baseline arguments", () => {
    assert.deepEqual(parseArgs([
        "--url", "http://127.0.0.1:8001/healthz",
        "--requests", "12",
        "--concurrency", "3",
        "--timeout-ms", "800",
    ]), {
        concurrency: 3,
        output: null,
        requests: 12,
        timeoutMs: 800,
        url: "http://127.0.0.1:8001/healthz",
    })
    assert.throws(() => parseArgs(["--requests", "0"]), /requests must be a positive integer/)
    assert.throws(() => parseArgs(["--concurrency", "0"]), /concurrency must be a positive integer/)
})

test("runs bounded concurrent requests and returns a report", async t => {
    const server = http.createServer((request, response) => {
        response.writeHead(request.url === "/ok" ? 200 : 404, { "content-type": "text/plain" })
        response.end("ok")
    })
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    t.after(() => server.close())
    const { port } = server.address()

    const result = await runHttpBaseline({
        concurrency: 2,
        requests: 5,
        timeoutMs: 1000,
        url: `http://127.0.0.1:${port}/ok`,
    })

    assert.equal(result.summary.count, 5)
    assert.equal(result.summary.completed, 5)
    assert.equal(result.summary.errors, 0)
    assert.deepEqual(result.summary.statusCounts, { "200": 5 })
    assert.equal(result.workload.concurrency, 2)
    assert.equal(result.workload.requests, 5)
})
