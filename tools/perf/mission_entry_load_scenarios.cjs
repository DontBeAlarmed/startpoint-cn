"use strict"

require("ts-node/register/transpile-only")

const crypto = require("node:crypto")
const path = require("node:path")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const {
    AWAKE_CHARACTER_ID,
    executeBattleFinish,
    prepareAwakeCharacter,
    summarizeBattleFinish,
} = require("./mission_engine_focused_scenarios.cjs")
const {
    createMissionProgressSummary,
} = require("./mission_engine_focused_helpers.cjs")

const ENTRY_NAMES = Object.freeze([
    "get-progress",
    "single-finish",
    "multi-finish",
    "character-bond",
])
const VIEWER_ID_BASE = 810_000_000
const projectRoot = path.resolve(__dirname, "../..")
const runtimeDependenciesByRoot = new Map()

function getRuntimeDependencies(runtimeRoot = projectRoot) {
    const resolvedRoot = path.resolve(runtimeRoot)
    const cached = runtimeDependenciesByRoot.get(resolvedRoot)
    if (cached) return cached
    const fromRuntime = relativePath => require(path.join(resolvedRoot, relativePath))
    const data = fromRuntime("src/data")
    const database = fromRuntime("src/data/db")
    const account = fromRuntime("src/data/domains/account")
    const character = fromRuntime("src/data/domains/character")
    const mission = fromRuntime("src/data/domains/mission")
    const player = fromRuntime("src/data/domains/player")
    const assets = fromRuntime("src/lib/assets")
    const characterLib = fromRuntime("src/lib/character")
    const awakeSettlement = fromRuntime("src/lib/mission/awake-settlement")
    const battleFacts = fromRuntime("src/lib/mission/battle-facts")
    const patterns = fromRuntime("src/lib/mission/patterns")
    const stages = fromRuntime("src/lib/mission/stages")
    const { getComputer } = fromRuntime("src/lib/mission/registry")
    const { settleMissionCategories } = fromRuntime("src/lib/mission/settlement")
    const missionRoutes = fromRuntime("src/routes/api/mission").default
    const bondRoutes = fromRuntime("src/routes/api/character/bond").default
    const { resolveRuntimeDataPaths } = fromRuntime("src/runtime/data-paths")
    const { getTimeOffset, setServerTimeOffset } = fromRuntime("src/utils")
    const {
        installBundledGameplaySnapshot,
    } = fromRuntime("tools/helpers/install-bundled-gameplay-snapshot.cjs")
    const runtimeDependencies = {
        ...data,
        ...database,
        ...account,
        ...character,
        ...mission,
        ...player,
        ...assets,
        ...characterLib,
        ...awakeSettlement,
        ...battleFacts,
        ...patterns,
        ...stages,
        bondRoutes,
        getComputer,
        getTimeOffset,
        installBundledGameplaySnapshot,
        missionRoutes,
        resolveRuntimeDataPaths,
        setServerTimeOffset,
        settleMissionCategories,
    }
    runtimeDependenciesByRoot.set(resolvedRoot, runtimeDependencies)
    return runtimeDependencies
}

function createPlayer(runtime, index) {
    const account = runtime.insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "mission-entry-load",
        idpId: `mission-entry-load-${index}`,
        status: "normal",
    })
    const playerId = runtime.insertDefaultPlayerSync(account.id).id
    const viewerId = VIEWER_ID_BASE + index
    runtime.getDb().prepare(`
        INSERT INTO sessions (token, account_id, expires, type)
        VALUES (?, ?, ?, 2)
    `).run(String(viewerId), account.id, "2099-12-31T23:59:59.000Z")
    return { playerId, viewerId }
}

function prepareBattlePlayer(runtime, playerId) {
    prepareAwakeCharacter(runtime, playerId)
    runtime.getDb().prepare(`
        INSERT INTO players_character_quest_clears (
            player_id, character_id, clear_count, multi_count,
            leader_clear_count, leader_multi_count, leader_power_flip_count
        ) VALUES (?, ?, 4, 0, 0, 0, 0)
    `).run(playerId, AWAKE_CHARACTER_ID)
}

function prepareBondPlayer(runtime, playerId) {
    prepareAwakeCharacter(runtime, playerId)
    runtime.updatePlayerCharacterSync(playerId, AWAKE_CHARACTER_ID, {
        overLimitStep: 10,
    })
}

function seedPlayers(runtime, count) {
    const players = []
    for (let index = 0; index < count; index++) {
        const entry = ENTRY_NAMES[index % ENTRY_NAMES.length]
        const identity = createPlayer(runtime, index)
        if (entry === "single-finish" || entry === "multi-finish") {
            prepareBattlePlayer(runtime, identity.playerId)
        } else if (entry === "character-bond") {
            prepareBondPlayer(runtime, identity.playerId)
        }
        players.push(Object.freeze({ ...identity, entry }))
    }
    return Object.freeze(players)
}

async function createRouteApp(runtime) {
    const app = Fastify({ logger: false })
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("application/x-msgpack")) {
            done(null, pack(payload))
            return
        }
        done(null, payload)
    })
    await app.register(runtime.missionRoutes)
    await app.register(runtime.bondRoutes)
    await app.ready()
    return app
}

function responseData(response, entry) {
    if (response.statusCode !== 200) {
        throw new Error(`${entry} route failed with ${response.statusCode}: ${response.body}`)
    }
    return unpack(response.rawPayload).data
}

function stableHash(value) {
    return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function missionRewardIds(data) {
    return (data.mission_info ?? [])
        .map(info => info.mission_reward_id)
        .sort((left, right) => left - right)
}

async function executeEntry(runtime, app, identity, fixedTime) {
    if (identity.entry === "get-progress") {
        const response = await app.inject({
            method: "POST",
            url: "/get_mission_progress",
            payload: {
                viewer_id: identity.viewerId,
                api_count: 1,
                category_list: [{ category: 1 }],
            },
        })
        const data = responseData(response, identity.entry)
        return {
            adapter: "fastify-route:/get_mission_progress",
            statusCode: response.statusCode,
            ...createMissionProgressSummary(data.mission_progress_list),
            missionRewardIds: missionRewardIds(data),
        }
    }
    if (identity.entry === "single-finish" || identity.entry === "multi-finish") {
        const outcome = executeBattleFinish(
            runtime,
            identity.playerId,
            fixedTime,
            identity.entry === "multi-finish",
        )
        return summarizeBattleFinish(runtime, outcome, identity.playerId)
    }
    const response = await app.inject({
        method: "POST",
        url: "/open_mana_board",
        payload: {
            viewer_id: identity.viewerId,
            character_id: AWAKE_CHARACTER_ID,
            mana_board_index: 2,
            api_count: 1,
        },
    })
    const data = responseData(response, identity.entry)
    return {
        adapter: "fastify-route:/open_mana_board",
        statusCode: response.statusCode,
        missionRewardIds: missionRewardIds(data),
        characterCount: data.character_list?.length ?? 0,
    }
}

function behaviorSignature(behavior) {
    return stableHash(behavior)
}

module.exports = {
    ENTRY_NAMES,
    behaviorSignature,
    createRouteApp,
    executeEntry,
    getRuntimeDependencies,
    seedPlayers,
}
