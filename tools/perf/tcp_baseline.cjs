#!/usr/bin/env node
"use strict"

require("ts-node/register/transpile-only")

const fs = require("node:fs")
const net = require("node:net")
const {
    listActiveRooms,
} = require("../../src/multi/room/manager")
const {
    getSessionServerStatus,
    startSessionServer,
    stopSessionServer,
} = require("../../src/multi/tcp/server")
const { createTcpFixtures, disposeTcpFixtures } = require("./tcp_fixtures.cjs")
const { closeSocket, connectClient } = require("./tcp_protocol_client.cjs")

const DEFAULT_CLIENTS_PER_ROOM = 3
const DEFAULT_ROOMS = 1
const DEFAULT_TIMEOUT_MS = 5000

function positiveInteger(value, name) {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`)
    }
    return parsed
}

function parseArgs(argv) {
    const parsed = {
        clientsPerRoom: DEFAULT_CLIENTS_PER_ROOM,
        output: null,
        rooms: DEFAULT_ROOMS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
    }
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        const value = argv[++index]
        if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`)
        if (argument === "--clients-per-room") parsed.clientsPerRoom = positiveInteger(value, "clients-per-room")
        else if (argument === "--rooms") parsed.rooms = positiveInteger(value, "rooms")
        else if (argument === "--timeout-ms") parsed.timeoutMs = positiveInteger(value, "timeout-ms")
        else if (argument === "--output") parsed.output = value
        else throw new Error(`unknown argument: ${argument}`)
    }
    if (parsed.clientsPerRoom > 3) throw new Error("clients-per-room cannot exceed 3")
    return parsed
}

function percentile(values, quantile) {
    if (values.length === 0) return null
    const sorted = [...values].sort((left, right) => left - right)
    const rank = Math.max(1, Math.ceil(sorted.length * quantile)) - 1
    return sorted[rank]
}

function reservePort() {
    const probe = net.createServer()
    return new Promise((resolve, reject) => {
        probe.once("error", reject)
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address()
            const port = typeof address === "object" && address !== null ? address.port : null
            probe.close(error => error ? reject(error) : resolve(port))
        })
    })
}

function summarizeSamples(samples, cleanup) {
    const completed = samples.filter(sample => !sample.error)
    return {
        activeSocketsAfterCleanup: cleanup.activeSockets,
        completed: completed.length,
        errors: samples.length - completed.length,
        p50ConnectMs: percentile(completed.map(sample => sample.handshakeMs), 0.5),
        p50HeartbeatMs: percentile(completed.map(sample => sample.heartbeatMs), 0.5),
        p95ConnectMs: percentile(completed.map(sample => sample.handshakeMs), 0.95),
        p95HeartbeatMs: percentile(completed.map(sample => sample.heartbeatMs), 0.95),
        p99ConnectMs: percentile(completed.map(sample => sample.handshakeMs), 0.99),
        p99HeartbeatMs: percentile(completed.map(sample => sample.heartbeatMs), 0.99),
        peakActiveSockets: cleanup.peakActiveSockets,
        remainingRooms: cleanup.remainingRooms,
        total: samples.length,
    }
}

async function waitFor(predicate, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(message)
}

async function runTcpBaseline({
    clientsPerRoom = DEFAULT_CLIENTS_PER_ROOM,
    rooms = DEFAULT_ROOMS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const normalizedClients = positiveInteger(clientsPerRoom, "clients-per-room")
    const normalizedRooms = positiveInteger(rooms, "rooms")
    const workload = {
        clientsPerRoom: normalizedClients,
        rooms: normalizedRooms,
        totalClients: normalizedClients * normalizedRooms,
        timeoutMs: positiveInteger(timeoutMs, "timeout-ms"),
    }
    if (workload.clientsPerRoom > 3) throw new Error("clients-per-room cannot exceed 3")

    const port = await reservePort()
    const fixtures = createTcpFixtures(workload)
    const fixtureRoomNumbers = new Set(fixtures.map(fixture => fixture.roomNumber))
    const samples = []
    const socketsByRoom = new Map()
    let peakActiveSockets = 0
    let cleanup = null
    try {
        await startSessionServer({ host: "127.0.0.1", port })
        for (const fixture of fixtures) {
            const results = await Promise.all(fixture.clients.map(client => connectClient({
                ...client,
                port,
                roomNumber: fixture.roomNumber,
                timeoutMs: workload.timeoutMs,
            })))
            samples.push(...results)
            socketsByRoom.set(fixture.roomNumber, results)
            peakActiveSockets = Math.max(peakActiveSockets, getSessionServerStatus().activeSockets)
        }

        for (const fixture of fixtures) {
            const roomClients = socketsByRoom.get(fixture.roomNumber) ?? []
            await closeSocket(roomClients[0]?.socket)
            await Promise.all(roomClients.slice(1).map(client => closeSocket(client.socket)))
        }
        await waitFor(
            () => getSessionServerStatus().activeSockets === 0,
            workload.timeoutMs,
            "TCP sessions did not clean up before timeout",
        )
    } finally {
        const activeSocketsBeforeStop = getSessionServerStatus().activeSockets
        const remainingRooms = listActiveRooms()
            .filter(room => fixtureRoomNumbers.has(room.room_number)).length
        disposeTcpFixtures(fixtures)
        await stopSessionServer()
        cleanup = {
            activeSockets: activeSocketsBeforeStop,
            peakActiveSockets,
            remainingRooms,
        }
    }
    return {
        startedAt: new Date().toISOString(),
        workload,
        summary: summarizeSamples(samples, cleanup),
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2))
    const report = await runTcpBaseline(options)
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

module.exports = { parseArgs, runTcpBaseline }
