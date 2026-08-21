"use strict"

const assert = require("node:assert/strict")

const workload = require("./multi_hub_load_workload.cjs")

function successfulBatch(scenarios) {
    return {
        rooms: scenarios.map(scenario => ({
            durationMs: scenario.scenarioIndex + 0.25,
            outcome: {
                ownerSide: scenario.ownerSide,
                hostRewarded: true,
                guestRewarded: true,
                duplicateFinishRejected: 2,
            },
            scenarioIndex: scenario.scenarioIndex,
        })),
        coexistence: {
            attempted: 6,
            completed: 6,
            errors: 0,
            routes: { auth: 2, load: 2, mission: 2 },
        },
    }
}

function fakeDependencies(observed) {
    return {
        harnessFactory() {
            const harness = {
                id: observed.harnesses.length,
                peers: [],
                processes: [],
                root: `/finite-root-${observed.harnesses.length}`,
                async cleanup() { observed.cleaned.push(this.id) },
            }
            observed.harnesses.push(harness)
            return harness
        },
        async runtimeSetup({ harness }) {
            observed.runtimeHarnesses.push(harness.id)
            return { ports: [10_001, 10_002, 10_003, 10_004] }
        },
        async participantsFactory({ profile }) {
            return {
                scenarios: workload.createScenarioPlan(profile),
                spectators: [{ side: "host" }, { side: "client" }],
            }
        },
        async batchRunner({ scenarios }) {
            observed.batches.push(scenarios.map(item => item.scenarioIndex))
            return successfulBatch(scenarios)
        },
        activeQuestCounter() { return 0 },
        async cleanupProbe({ harness, ports }) {
            assert.ok(observed.cleaned.includes(harness.id))
            assert.equal(ports.length, 4)
            return {
                activePeers: 0,
                activeProcesses: 0,
                portsReleased: true,
                remainingRooms: 0,
                temporaryRootExists: false,
            }
        },
    }
}

function successfulHttp(data = {}) {
    return {
        status: 200,
        headers: { "content-type": "application/x-msgpack" },
        body: { data_headers: { result_code: 1 }, data },
    }
}

function cleanupFixture(overrides = {}) {
    const node = { dataKey: "host", playerId: 1, url: "host", viewerId: 11 }
    const peer = overrides.peer ?? { close: async () => {} }
    const harness = {
        async gamePost(_url, route) {
            if (route.endsWith("/abort")) {
                if (overrides.abortError) throw overrides.abortError
                return overrides.abort ?? successfulHttp()
            }
            if (route.endsWith("/disband_room")) {
                if (overrides.disbandError) throw overrides.disbandError
                return overrides.disband ?? successfulHttp()
            }
            if (route.endsWith("/search_room")) {
                if (overrides.searchError) throw overrides.searchError
                return overrides.search ?? successfulHttp({ room_exists: false })
            }
            throw new Error("unexpected route")
        },
    }
    return {
        harness,
        entry: {
            scenario: { scenarioIndex: 0, ownerSide: "host", nodes: [node] },
            party: { roomNumber: 123456, lobby: [{ peer }] },
            startedAt: performance.now(),
            stage: "finish",
        },
        node,
    }
}

function coexistenceHarness(mutator = () => {}) {
    const node = { accountId: 7, deviceId: 77, viewerId: 700, url: "host" }
    const responses = {
        auth: {
            ...successfulHttp({ newAccount: 0 }),
            headers: new Headers({ "content-type": "application/x-msgpack" }),
        },
        load: successfulHttp({
            unfinished_quest_list: [],
            unfinished_multi_quest_list: [],
        }),
        mission: successfulHttp({
            mission_progress_list: [{
                mission_category: 1,
                mission_id: 1,
                progress_value: 0,
                stage: 1,
            }],
        }),
    }
    responses.load.headers = { "Content-Type": "application/x-msgpack; charset=binary" }
    responses.auth.body.data_headers.viewer_id = node.viewerId
    responses.load.body.data_headers.viewer_id = node.accountId
    responses.load.body.data_headers.asset_update = false
    responses.mission.body.data_headers.viewer_id = node.viewerId
    mutator(responses)
    return {
        node,
        harness: {
            async gamePost(_url, route) {
                if (route.endsWith("/signup")) return responses.auth
                if (route.endsWith("/load")) return responses.load
                if (route.endsWith("/get_mission_progress")) return responses.mission
                throw new Error("unexpected route")
            },
        },
    }
}

module.exports = {
    cleanupFixture,
    coexistenceHarness,
    fakeDependencies,
    successfulBatch,
    successfulHttp,
}
