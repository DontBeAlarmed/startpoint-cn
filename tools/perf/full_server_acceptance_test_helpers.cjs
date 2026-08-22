"use strict"

const {
    ENTRY_NAMES,
    FORMAL_ACTIVE_IDENTITIES,
    FORMAL_CONCURRENCY_STEPS,
    FORMAL_ENTRY_REQUESTS,
    FORMAL_INDEPENDENT_SAVES,
    createAdmissionGate,
} = require("./non_multi_mixed_metrics.cjs")
const {
    FORMAL_MULTI_PROFILE,
    SMOKE_MULTI_PROFILE,
    createBehaviorSignature,
    createMultiHubAdmission,
} = require("./multi_hub_load_metrics.cjs")
const acceptance = require("./full_server_acceptance.cjs")

function nonMultiReport({ formal = true, p95 = 100 } = {}) {
    const profile = formal
        ? {
            independentSaves: FORMAL_INDEPENDENT_SAVES,
            activeIdentities: FORMAL_ACTIVE_IDENTITIES,
            concurrencySteps: [...FORMAL_CONCURRENCY_STEPS],
        }
        : { independentSaves: 7, activeIdentities: 7, concurrencySteps: [2] }
    const entryRequests = formal ? [...FORMAL_ENTRY_REQUESTS] : Array(ENTRY_NAMES.length).fill(1)
    const core = {
        metadata: {
            fixedTime: "2024-08-14T12:00:00.000Z",
            activeIdentitiesAreConcurrentRequests: false,
            entryDistribution: ENTRY_NAMES.map((name, index) => ({
                name,
                requests: entryRequests[index],
                weight: entryRequests[index] / profile.activeIdentities,
            })),
            entryDistributionNote: "acceptance coverage; not production traffic proportions",
        },
        profile,
        steps: profile.concurrencySteps.map((concurrency, stepIndex) => ({
            concurrency,
            requests: profile.activeIdentities,
            errors: 0,
            latencyMs: { p50: p95 / 2, p95: p95 - stepIndex },
            throughputPerSecond: 100,
            eventLoopDelayMs: { p50: 0.1, p95: 0.2, max: 0.3 },
            entries: ENTRY_NAMES.map((name, entryIndex) => ({
                name,
                requests: entryRequests[entryIndex],
                errors: 0,
                latencyMs: { p50: 1, p95: 2 },
                behaviorSignatures: formal && ["load", "single-battle"].includes(name)
                    ? [`${name}-large`, `${name}-new`, `${name}-small`]
                    : [`${name}-stable`],
                sql: { readsMax: 3, writesMax: 2 },
                rollbackVerified: true,
            })),
        })),
    }
    return { ...core, gate: createAdmissionGate(core) }
}

function multiReport({ formal = true, p95 = 50 } = {}) {
    const source = formal ? FORMAL_MULTI_PROFILE : SMOKE_MULTI_PROFILE
    const profile = {
        activeIdentities: source.activeIdentities,
        clientOwnedRooms: source.clientOwnedRooms,
        concurrencySteps: [...source.concurrencySteps],
        hostOwnedRooms: source.hostOwnedRooms,
        totalRooms: source.totalRooms,
    }
    const signatures = [
        ...(profile.hostOwnedRooms > 0 ? [createBehaviorSignature({
            ownerSide: "host",
            hostRewarded: true,
            guestRewarded: true,
            duplicateFinishRejected: 2,
        })] : []),
        ...(profile.clientOwnedRooms > 0 ? [createBehaviorSignature({
            ownerSide: "client",
            hostRewarded: true,
            guestRewarded: true,
            duplicateFinishRejected: 2,
        })] : []),
    ].sort()
    const core = {
        schemaVersion: 1,
        profile,
        steps: profile.concurrencySteps.map((concurrency, stepIndex) => ({
            concurrency,
            rooms: {
                attempted: profile.totalRooms,
                completed: profile.totalRooms,
                hostOwned: profile.hostOwnedRooms,
                clientOwned: profile.clientOwnedRooms,
            },
            players: { attempted: profile.activeIdentities, completed: profile.activeIdentities },
            coexistence: {
                attempted: Math.max(3, profile.activeIdentities),
                completed: Math.max(3, profile.activeIdentities),
                errors: 0,
                routes: {
                    auth: 1,
                    load: 1,
                    mission: Math.max(3, profile.activeIdentities) - 2,
                },
            },
            settlement: {
                duplicateFinishRejected: profile.activeIdentities,
                activeQuestsAfter: 0,
                errors: 0,
            },
            cleanup: {
                activePeers: 0,
                activeProcesses: 0,
                remainingRooms: 0,
                portsReleased: true,
                temporaryRootExists: false,
            },
            behaviorSignatures: signatures,
            latencyMs: { p50: p95 / 2, p95: p95 - stepIndex, p99: p95 + 1 },
            errors: [],
        })),
    }
    return { ...core, gate: createMultiHubAdmission(core) }
}

function fakeRun(reports, calls, name) {
    let index = 0
    return async options => {
        calls.push(`${name}-${index + 1}-${options.formal}`)
        return reports[index++]
    }
}

async function formalRun({ nonMultiP95 = [100, 100, 100], multiP95 = [50, 50, 50], readReference } = {}) {
    const calls = []
    const report = await acceptance.runFullServerAcceptance({
        formal: true,
        rounds: 3,
        runNonMulti: fakeRun(nonMultiP95.map(p95 => nonMultiReport({ p95 })), calls, "non"),
        runMulti: fakeRun(multiP95.map(p95 => multiReport({ p95 })), calls, "multi"),
        readReference: readReference ?? (async () => null),
    })
    return { calls, report }
}

module.exports = { formalRun, multiReport, nonMultiReport }
