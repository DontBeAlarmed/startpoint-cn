#!/usr/bin/env node
"use strict"

const fs = require("node:fs")
const { performance } = require("node:perf_hooks")
const {
    MultiHubProcessHarness,
    reserveLoopbackPorts,
} = require("../../tests/helpers/multi-hub-process-harness")

const {
    API_PREFIX,
    QUEST,
    assertSameEndpoint,
    createRoom,
    disbandRoom,
    openPeer,
    prepareRoom,
    roomStillExists,
    signUp,
} = require("./hub_baseline_helpers.cjs")
const DEFAULT_ROOMS = 1
const DEFAULT_TIMEOUT_MS = 5_000

function positiveInteger(value, name) {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`)
    }
    return parsed
}

function parseArgs(argv) {
    const parsed = { output: null, rooms: DEFAULT_ROOMS, timeoutMs: DEFAULT_TIMEOUT_MS }
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        const value = argv[++index]
        if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`)
        if (argument === "--rooms") parsed.rooms = positiveInteger(value, "rooms")
        else if (argument === "--timeout-ms") parsed.timeoutMs = positiveInteger(value, "timeout-ms")
        else if (argument === "--output") parsed.output = value
        else throw new Error(`unknown argument: ${argument}`)
    }
    return parsed
}

function percentile(values, quantile) {
    if (values.length === 0) return null
    const sorted = [...values].sort((left, right) => left - right)
    const rank = Math.max(1, Math.ceil(sorted.length * quantile)) - 1
    return sorted[rank]
}

function buildSummary(records, cleanup) {
    const completed = records.filter(record => record.error === null)
    const errors = [
        ...records.filter(record => record.error !== null).map(record => record.error),
        ...(cleanup.errors ?? []),
    ]
    return {
        activePeersAfterCleanup: cleanup.activePeers,
        completedRooms: completed.length,
        errors: errors.length,
        p50HandshakeMs: percentile(completed.map(record => record.handshakeMs), 0.5),
        p50HeartbeatMs: percentile(completed.map(record => record.heartbeatMs), 0.5),
        p50PrepareMs: percentile(completed.map(record => record.prepareMs), 0.5),
        p95HandshakeMs: percentile(completed.map(record => record.handshakeMs), 0.95),
        p95HeartbeatMs: percentile(completed.map(record => record.heartbeatMs), 0.95),
        p95PrepareMs: percentile(completed.map(record => record.prepareMs), 0.95),
        p99HandshakeMs: percentile(completed.map(record => record.handshakeMs), 0.99),
        p99HeartbeatMs: percentile(completed.map(record => record.heartbeatMs), 0.99),
        p99PrepareMs: percentile(completed.map(record => record.prepareMs), 0.99),
        peakPeers: cleanup.peakPeers,
        remainingRooms: cleanup.remainingRooms,
        totalRooms: cleanup.totalRooms,
        errorDetails: errors,
    }
}

async function runHubBaseline({
    rooms = DEFAULT_ROOMS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const normalizedRooms = positiveInteger(rooms, "rooms")
    const normalizedTimeout = positiveInteger(timeoutMs, "timeout-ms")
    const workload = {
        rooms: normalizedRooms,
        timeoutMs: normalizedTimeout,
        totalPeers: normalizedRooms * 2,
    }
    const harness = new MultiHubProcessHarness()
    const createdRooms = []
    const records = []
    let peakPeers = 0
    let cleanup = null
    const cleanupErrors = []

    const host = { dataKey: "host" }
    const client = { dataKey: "client-b" }
    try {
        harness.installRuntimeTables()
        const credential = harness.createCredential("hub-baseline-client")
        const [hostHttp, hubPort, tcpPort, clientHttp] = await reserveLoopbackPorts(4)
        host.url = `http://127.0.0.1:${hostHttp}`
        client.url = `http://127.0.0.1:${clientHttp}`

        const hostRuntime = harness.spawnRuntime("hub-host", {
            CN_LISTEN_PORT: String(hostHttp),
            DATA_DIR: harness.dataDir(host.dataKey),
            MULTI_HUB_HOST: "127.0.0.1",
            MULTI_HUB_PORT: String(hubPort),
            MULTI_MODE: "host",
            SESSION_HOST: "127.0.0.1",
            SESSION_PORT: String(tcpPort),
            SESSION_PUBLIC_HOST: "127.0.0.1",
        }, [hostHttp, hubPort, tcpPort])
        const clientRuntime = harness.spawnRuntime("hub-client", {
            CN_LISTEN_PORT: String(clientHttp),
            DATA_DIR: harness.dataDir(client.dataKey),
            MULTI_HUB_TOKEN: credential.token,
            MULTI_HUB_URL: `http://127.0.0.1:${hubPort}/`,
            MULTI_MODE: "client",
        }, [clientHttp])
        await Promise.all([
            harness.waitForHealth(host.url, hostRuntime),
            harness.waitForHealth(client.url, clientRuntime),
        ])

        const deviceSuffix = Date.now() % 1_000_000
        await signUp(harness, host, 810_000_000 + deviceSuffix)
        await signUp(harness, client, 820_000_000 + deviceSuffix)

        const preparedRooms = []
        for (let index = 0; index < normalizedRooms; index++) {
            let roomNumber = null
            try {
                roomNumber = await createRoom(harness, host, index + 1)
                createdRooms.push(roomNumber)
                const hostEndpoint = await prepareRoom(harness, host, roomNumber)
                const startedAt = performance.now()
                const endpoint = await prepareRoom(harness, client, roomNumber)
                assertSameEndpoint(hostEndpoint, endpoint)
                preparedRooms.push({ endpoint, prepareMs: performance.now() - startedAt, roomNumber })
            } catch (error) {
                records.push({
                    error: `room ${roomNumber ?? index + 1}: ${String(error?.message ?? error)}`,
                    heartbeatMs: null,
                    handshakeMs: null,
                    prepareMs: null,
                })
            }
        }

        const peerResults = await Promise.all(preparedRooms.flatMap(room => [
            openPeer(harness, host, room.endpoint, room.roomNumber, "host", normalizedTimeout),
            openPeer(harness, client, room.endpoint, room.roomNumber, "client", normalizedTimeout),
        ]))
        peakPeers = Math.max(peakPeers, harness.peers.filter(peer => !peer.closed).length)
        const byRoom = new Map()
        for (let index = 0; index < preparedRooms.length; index++) {
            const room = preparedRooms[index]
            const hostPeer = peerResults[index * 2]
            const clientPeer = peerResults[index * 2 + 1]
            const errors = [hostPeer.error, clientPeer.error].filter(Boolean)
            const error = errors.length > 0 ? errors.join("; ") : null
            records.push({
                error,
                handshakeMs: error === null
                    ? Math.max(hostPeer.handshakeMs, clientPeer.handshakeMs)
                    : null,
                heartbeatMs: error === null
                    ? Math.max(hostPeer.heartbeatMs, clientPeer.heartbeatMs)
                    : null,
                prepareMs: room.prepareMs,
            })
            byRoom.set(room.roomNumber, [hostPeer.peer, clientPeer.peer])
        }

        for (const roomNumber of createdRooms) {
            const [hostPeer, clientPeer] = byRoom.get(roomNumber) ?? []
            if (clientPeer) await clientPeer.close()
            try {
                await disbandRoom(harness, host, roomNumber)
            } catch (error) {
                try {
                    if (await roomStillExists(harness, host, roomNumber)) {
                        cleanupErrors.push(`room ${roomNumber} disband: ${String(error?.message ?? error)}`)
                    }
                } catch (statusError) {
                    cleanupErrors.push(`room ${roomNumber} cleanup: ${String(statusError?.message ?? statusError)}`)
                }
            }
            if (hostPeer) await hostPeer.close()
        }
        const remainingRooms = (await Promise.all(createdRooms.map(async roomNumber => {
            try {
                return await roomStillExists(harness, host, roomNumber)
            } catch (error) {
                cleanupErrors.push(`room ${roomNumber} status: ${String(error?.message ?? error)}`)
                return true
            }
        }))).filter(Boolean).length
        cleanup = {
            activePeers: harness.peers.filter(peer => !peer.closed).length,
            errors: cleanupErrors,
            peakPeers,
            remainingRooms,
            totalRooms: normalizedRooms,
        }
    } finally {
        try {
            await harness.cleanup()
        } catch (error) {
            cleanupErrors.push(`harness cleanup: ${String(error?.message ?? error)}`)
        }
        const activePeers = harness.peers.filter(peer => !peer.closed).length
        if (cleanup) cleanup.activePeers = activePeers
        else cleanup = {
            activePeers,
            errors: cleanupErrors,
            peakPeers,
            remainingRooms: createdRooms.length,
            totalRooms: normalizedRooms,
        }
    }

    return {
        startedAt: new Date().toISOString(),
        workload,
        summary: buildSummary(records, cleanup),
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2))
    let report
    try {
        report = await runHubBaseline(options)
    } catch (error) {
        report = {
            startedAt: new Date().toISOString(),
            workload: {
                rooms: options.rooms,
                timeoutMs: options.timeoutMs,
                totalPeers: options.rooms * 2,
            },
            summary: {
                completedRooms: 0,
                errors: 1,
                errorDetails: [String(error?.message ?? error)],
                totalRooms: options.rooms,
            },
        }
        process.stderr.write(`${error.stack ?? error}\n`)
    }
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

module.exports = { parseArgs, runHubBaseline }
