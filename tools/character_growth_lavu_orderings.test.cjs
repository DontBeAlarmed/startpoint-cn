"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const LAVU_ID = 263002
const BARETTA_ID = 151006
const LAVU_AWAKE_MISSION_IDS = [2630021, 2630022, 2630023, 2630024]
const LAVU_STORY_QUEST_IDS = [26300201, 26300202, 26300203]
const LAVU_AWAKE_MANA_TARGET = 604800
const LAVU_CHALLENGE_CATEGORY = 18
const LAVU_CHALLENGE_QUEST_ID = 400001104
const EVALUATION_TIME = new Date("2025-01-01T12:00:00.000Z")

const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
delete process.env.WDFP_DATABASE_DIR

const fixture = require("./helpers/character-growth-c4-fixture.cjs")
    .createCharacterGrowthC4Fixture()
const {
    getPlayerCharacterManaNodeAwakeLevelsSync,
    getPlayerCharacterSync,
} = require("../src/data/domains/character")
const { getPlayerCharacterAwakeUnlocksSync } = require("../src/data/domains/character_awake")
const { getPlayerItemsSync } = require("../src/data/domains/item")
const {
    getPlayerCategoryMissionsSync,
} = require("../src/data/domains/mission")
const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")
const { getPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getClientSerializedData } = require("../src/data/utils/player-data")
const {
    getCharacterDataSync,
    getCharacterManaNodesSync,
    getManaNodeAwakeCost,
} = require("../src/lib/assets")
const { characterExpCaps } = require("../src/lib/character")
const { mutationContent } = require("../src/lib/character-growth/node-command-support")
const { getCurrentStage } = require("../src/lib/mission/stages")
const { insertActiveQuest } = require("../src/lib/quest/active-quest-service")
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
setServerTimeOffset(EVALUATION_TIME.getTime() - Date.now())

const commandCaptures = []
const patchedCommands = []

function captureCommand(modulePath, exportName, commandName) {
    const commandModule = require(modulePath)
    const original = commandModule[exportName]
    assert.equal(typeof original, "function", `${modulePath}.${exportName} must be callable`)
    commandModule[exportName] = (...args) => {
        const result = original(...args)
        commandCaptures.push({ commandName, result })
        return result
    }
    patchedCommands.push(() => { commandModule[exportName] = original })
}

for (const command of [
    ["learn-mana-nodes", "executeLearnManaNodes", "learn_mana_nodes"],
    ["awake-mana-nodes", "executeAwakeManaNodes", "awake_mana_nodes"],
    ["receive-bond-token", "receiveBondToken", "receive_bond_token"],
    ["open-mana-board", "openManaBoard", "open_mana_board"],
]) {
    captureCommand(`../src/lib/character-growth/commands/${command[0]}`, command[1], command[2])
}

// Load route modules only after installing command capture wrappers. The wrappers
// observe the exact result used by the real HTTP adapters without changing it.
const bondRoutes = require("../src/routes/api/character/bond").default
const manaRoutes = require("../src/routes/api/character/mana").default
const missionRoutes = require("../src/routes/api/mission").default
const singleBattleRoutes = require("../src/routes/api/singleBattleQuest").default
const cnLoadRoutes = require("../src/routes/cn/load").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

function sortedEntries(record) {
    return Object.entries(record)
        .map(([key, value]) => [Number(key), value])
        .sort(([left], [right]) => left - right)
}

function sortedTokenList(tokens) {
    return tokens
        .map(token => ({
            mana_board_index: token.mana_board_index ?? token.manaBoardIndex,
            status: token.status,
        }))
        .sort((left, right) => left.mana_board_index - right.mana_board_index)
}

function currentAwakeMissionState(playerId, missionId) {
    const persisted = getPlayerCategoryMissionsSync(playerId, 9)[missionId]
    const progress = persisted?.progress ?? 0
    return {
        progress,
        stage: getCurrentStage(9, missionId, progress),
    }
}

function receivedStageNumbers(stages) {
    return Object.entries(stages ?? {})
        .filter(([, received]) => received === true)
        .map(([stage]) => Number(stage))
        .sort((left, right) => left - right)
}

function assertAwakeLoadMatchesDb(playerId, data) {
    const entries = new Map((data.active_mission_list ?? [])
        .filter(entry => LAVU_AWAKE_MISSION_IDS.includes(Number(entry.mission_id)))
        .map(entry => [Number(entry.mission_id), entry]))
    assert.equal(entries.size, LAVU_AWAKE_MISSION_IDS.length)

    const persisted = getPlayerCategoryMissionsSync(playerId, 9)
    for (const missionId of LAVU_AWAKE_MISSION_IDS) {
        const entry = entries.get(missionId)
        assert.ok(entry, `load must contain Lavu Awake mission ${missionId}`)
        assert.equal(entry.progress_value, persisted[missionId]?.progress ?? 0)
        assert.deepEqual(
            (entry.stages ?? [])
                .filter(stage => stage.received === true)
                .map(stage => Number(stage.stage))
                .sort((left, right) => left - right),
            receivedStageNumbers(persisted[missionId]?.stages),
        )
    }
}

function clientStateFromLoad(data, growthItemIds) {
    const character = structuredClone(data.user_character_list[String(LAVU_ID)])
    assert.ok(character, "initial load must contain Lavu")
    return {
        character,
        manaNodes: new Map(
            (data.user_character_mana_node_list[String(LAVU_ID)] ?? [])
                .map(entry => [entry.multiplied_id, entry.awake_level]),
        ),
        bondToken: data.user_info.bond_token,
        freeMana: data.user_info.free_mana,
        paidMana: data.user_info.paid_mana,
        growthItemIds: new Set(growthItemIds),
        items: new Map(growthItemIds.map(itemId => [itemId, data.item_list[String(itemId)] ?? 0])),
        awakeMissions: new Map((data.active_mission_list ?? [])
            .filter(entry => LAVU_AWAKE_MISSION_IDS.includes(Number(entry.mission_id)))
            .map(entry => [Number(entry.mission_id), {
                progress: Number(entry.progress_value),
                stage: getCurrentStage(9, Number(entry.mission_id), Number(entry.progress_value)),
            }])),
    }
}

function applyClientResponse(client, data) {
    const characterUpdate = (data.character_list ?? [])
        .find(entry => Number(entry.character_id) === LAVU_ID)
    if (characterUpdate) {
        for (const [field, value] of Object.entries(characterUpdate)) {
            if (field === "mana_board_awake") {
                client.character.mana_board_awake = {
                    ...(client.character.mana_board_awake ?? {}),
                    ...structuredClone(value),
                }
            } else {
                client.character[field] = structuredClone(value)
            }
        }
    }
    for (const entry of data.user_character_mana_node_list?.[String(LAVU_ID)] ?? []) {
        client.manaNodes.set(entry.multiplied_id, entry.awake_level)
    }
    if (data.user_info) {
        if (Object.prototype.hasOwnProperty.call(data.user_info, "bond_token")) {
            client.bondToken = data.user_info.bond_token
        }
        if (Object.prototype.hasOwnProperty.call(data.user_info, "free_mana")) {
            client.freeMana = data.user_info.free_mana
        }
        if (Object.prototype.hasOwnProperty.call(data.user_info, "paid_mana")) {
            client.paidMana = data.user_info.paid_mana
        }
    }
    for (const [rawItemId, amount] of Object.entries(data.item_list ?? {})) {
        const itemId = Number(rawItemId)
        if (client.growthItemIds.has(itemId)) client.items.set(itemId, amount)
    }
    for (const mission of data.mission_progress_list ?? []) {
        const missionId = Number(mission.mission_id)
        if (!LAVU_AWAKE_MISSION_IDS.includes(missionId)) continue
        client.awakeMissions.set(missionId, {
            progress: Number(mission.progress_value),
            stage: Number(mission.stage),
        })
    }
}

function syncClientWithDb(player, data, options = {}) {
    applyClientResponse(player.client, data)
    assertClientMatchesDb(player.playerId, player.client, options)
}

function persistedAwakeMap(playerId) {
    return getPlayerCharacterAwakeUnlocksSync(playerId).get(String(LAVU_ID)) ?? {}
}

function assertCommandResultMatchesDb(playerId, result, responseData) {
    const character = getPlayerCharacterSync(playerId, LAVU_ID)
    const player = getPlayerSync(playerId)
    assert.ok(character)
    assert.ok(player)
    assert.equal(result.after.characterId, LAVU_ID)
    assert.equal(result.after.manaBoardIndex, character.manaBoardIndex)
    assert.equal(result.after.evolutionLevel, character.evolutionLevel)
    if (result.after.bondTokens !== undefined) {
        assert.deepEqual(
            [...result.after.bondTokens].map(([mana_board_index, status]) => ({
                mana_board_index,
                status,
            })),
            sortedTokenList(character.bondTokenList),
        )
    }
    if (result.after.normalManaNodes !== undefined) {
        assert.deepEqual(
            [...result.after.normalManaNodes].sort(([left], [right]) => left - right),
            sortedEntries(getPlayerCharacterManaNodeAwakeLevelsSync(playerId, LAVU_ID)),
        )
    }
    if (result.after.awakeUnlocks !== undefined) {
        assert.deepEqual(
            [...result.after.awakeUnlocks].sort(([left], [right]) => left - right),
            sortedEntries(persistedAwakeMap(playerId)),
        )
    }
    if (result.resourceState !== undefined) {
        const resourceState = result.resourceState
        assert.equal(resourceState.freeMana, player.freeMana)
        assert.equal(resourceState.paidMana, player.paidMana)
        assert.equal(resourceState.mana, player.freeMana + player.paidMana)
        assert.equal(responseData.user_info.free_mana, resourceState.freeMana)
        assert.equal(responseData.user_info.paid_mana, resourceState.paidMana)
        const persistedItems = getPlayerItemsSync(playerId)
        for (const [itemId, amount] of resourceState.items ?? []) {
            assert.equal(persistedItems[String(itemId)] ?? 0, amount)
            assert.equal(responseData.item_list[String(itemId)], amount)
        }
    }
}

function assertClientMatchesDb(playerId, client, { missions = false } = {}) {
    const character = getPlayerCharacterSync(playerId, LAVU_ID)
    const player = getPlayerSync(playerId)
    assert.ok(character)
    assert.ok(player)
    assert.equal(client.character.mana_board_index, character.manaBoardIndex)
    assert.equal(client.character.evolution_level, character.evolutionLevel)
    assert.deepEqual(
        sortedTokenList(client.character.bond_token_list),
        sortedTokenList(character.bondTokenList),
    )
    assert.deepEqual(
        sortedEntries(client.character.mana_board_awake ?? {}),
        sortedEntries(persistedAwakeMap(playerId)),
    )
    assert.deepEqual(
        [...client.manaNodes].sort(([left], [right]) => left - right),
        sortedEntries(getPlayerCharacterManaNodeAwakeLevelsSync(playerId, LAVU_ID)),
    )
    assert.equal(client.bondToken, player.bondToken)
    assert.equal(client.freeMana, player.freeMana)
    assert.equal(client.paidMana, player.paidMana)
    const persistedItems = getPlayerItemsSync(playerId)
    assert.deepEqual(
        [...client.items].sort(([left], [right]) => left - right),
        [...client.growthItemIds]
            .map(itemId => [itemId, persistedItems[String(itemId)] ?? 0])
            .sort(([left], [right]) => left - right),
    )
    if (missions) {
        for (const missionId of LAVU_AWAKE_MISSION_IDS) {
            assert.deepEqual(
                client.awakeMissions.get(missionId),
                currentAwakeMissionState(playerId, missionId),
            )
        }
    }
}

async function createApp() {
    const app = Fastify({ logger: false })
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    registerCnMsgpackOnSend(app)
    await app.register(bondRoutes, { prefix: "/api/index.php/character" })
    await app.register(manaRoutes, { prefix: "/api/index.php/character" })
    await app.register(missionRoutes, { prefix: "/api/index.php/mission" })
    await app.register(singleBattleRoutes, { prefix: "/api/index.php/single_battle_quest" })
    await app.register(cnLoadRoutes, {
        prefix: "/api/index.php",
        assetProvider: { mode: "client-owned" },
    })
    await app.ready()
    return app
}

function allGrowthItemIds() {
    const itemIds = new Set()
    for (const boardIndex of [1, 2]) {
        const nodes = getCharacterManaNodesSync(LAVU_ID, boardIndex)
        assert.ok(nodes, `Lavu board ${boardIndex} must exist in CN Content`)
        for (const node of Object.values(nodes)) for (const itemId of Object.keys(node.items)) {
            itemIds.add(Number(itemId))
        }
    }
    const rarity = getCharacterDataSync(LAVU_ID).rarity
    for (const nodeId of Object.keys(getCharacterManaNodesSync(LAVU_ID, 1)).map(Number)) {
        const cost = getManaNodeAwakeCost(LAVU_ID, nodeId, rarity)
        assert.ok(cost, `Lavu Awake cost ${nodeId} must exist in CN Content`)
        for (const itemId of Object.keys(cost.items)) itemIds.add(Number(itemId))
    }
    return [...itemIds].filter(itemId => Number.isSafeInteger(itemId) && itemId > 0)
}

function orderedBoardNodeIds(boardIndex) {
    const content = mutationContent(LAVU_ID, boardIndex)
    const ordered = []
    const visiting = new Set()
    const visited = new Set()
    function visit(nodeId) {
        if (visited.has(nodeId)) return
        assert.equal(visiting.has(nodeId), false, `board ${boardIndex} must not contain a parent cycle`)
        visiting.add(nodeId)
        const parentId = content.parents[String(nodeId)]
        if (parentId !== null) visit(parentId)
        visiting.delete(nodeId)
        visited.add(nodeId)
        ordered.push(nodeId)
    }
    for (const nodeId of Object.keys(content.nodes).map(Number)) visit(nodeId)
    return ordered
}

async function createReachablePlayer() {
    const playerId = fixture.createPlayer()
    const viewerId = 880000000 + playerId
    await fixture.createViewer(playerId, viewerId)
    const rarity = getCharacterDataSync(LAVU_ID).rarity
    fixture.addCharacter(playerId, LAVU_ID, {
        exp: characterExpCaps[rarity][6],
        overLimitStep: 6,
    })
    fixture.addCharacter(playerId, BARETTA_ID)
    fixture.setPlayer(playerId, {
        freeMana: 100_000_000,
        paidMana: 0,
        totalManaObtained: 0,
    })
    const growthItemIds = allGrowthItemIds()
    for (const itemId of growthItemIds) fixture.giveItem(playerId, itemId, 1_000_000)

    const initialData = getClientSerializedData(playerId, { viewerId })
    const client = clientStateFromLoad(initialData, growthItemIds)
    assertClientMatchesDb(playerId, client)
    return {
        playerId,
        viewerId,
        client,
        growthItemIds,
        initialBondToken: getPlayerSync(playerId).bondToken,
    }
}

async function post(app, url, body) {
    const response = await app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(body).toString("base64"),
    })
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`)
    return unpack(Buffer.from(response.body, "base64")).data
}

async function runCommandStep(app, player, commandName, url, body, assertions = () => {}) {
    const captureIndex = commandCaptures.length
    const data = await post(app, url, { viewer_id: player.viewerId, api_count: 1, ...body })
    assert.equal(commandCaptures.length, captureIndex + 1, `${commandName} must execute exactly once`)
    const capture = commandCaptures[captureIndex]
    assert.equal(capture.commandName, commandName)
    assert.equal(capture.result.command, commandName)
    assertions(capture.result, data)
    syncClientWithDb(player, data)
    assertCommandResultMatchesDb(player.playerId, capture.result, data)
}

async function learnBoard(app, player, boardIndex) {
    const nodeIds = orderedBoardNodeIds(boardIndex)
    assert.equal(nodeIds.length > 1, true, `board ${boardIndex} must exercise a batch request`)
    await runCommandStep(
        app,
        player,
        "learn_mana_nodes",
        "/api/index.php/character/learn_mana_node",
        { character_id: LAVU_ID, mana_node_multiplied_id_list: nodeIds },
        result => {
            assert.deepEqual([...result.changedNodeIds].sort((a, b) => a - b), [...nodeIds].sort((a, b) => a - b))
            assert.equal(result.bondTokenGranted, true)
            assert.equal(result.after.bondTokens.get(boardIndex), 1)
        },
    )
}

async function receiveBoardToken(app, player, boardIndex, expectedReplay = false) {
    await runCommandStep(
        app,
        player,
        "receive_bond_token",
        "/api/index.php/character/receive_bond_token",
        { character_id: LAVU_ID, mana_board_index: boardIndex },
        result => {
            assert.equal(result.replayed, expectedReplay)
            assert.equal(result.playerBondTokenAfter - result.playerBondTokenBefore, expectedReplay ? 0 : 1)
        },
    )
}

async function openSecondBoard(app, player, expectedReplay = false) {
    await runCommandStep(
        app,
        player,
        "open_mana_board",
        "/api/index.php/character/open_mana_board",
        { character_id: LAVU_ID, mana_board_index: 2 },
        result => {
            assert.equal(result.replayed, expectedReplay)
            assert.equal(result.after.manaBoardIndex, 2)
        },
    )
}

function prepareLavuAwakeFacts(playerId) {
    for (const questId of LAVU_STORY_QUEST_IDS) {
        insertPlayerQuestProgressSync(playerId, 3, {
            questId,
            finished: true,
            unlocked: true,
            clearRank: 5,
        })
    }
    updatePlayerSync({ id: playerId, totalManaObtained: LAVU_AWAKE_MANA_TARGET })
}

function getLavuAwakePage(app, player) {
    return post(app, "/api/index.php/mission/get_mission_progress", {
        viewer_id: player.viewerId,
        api_count: 1,
        category_list: [{ category: 9, character_id: LAVU_ID }],
    })
}

function assertAwakeProgressResponseMatchesDb(playerId, data) {
    const entries = new Map((data.mission_progress_list ?? [])
        .filter(entry => LAVU_AWAKE_MISSION_IDS.includes(Number(entry.mission_id)))
        .map(entry => [Number(entry.mission_id), entry]))
    assert.equal(entries.size, LAVU_AWAKE_MISSION_IDS.length)
    for (const missionId of LAVU_AWAKE_MISSION_IDS) {
        const entry = entries.get(missionId)
        assert.ok(entry, `mission progress must contain Lavu Awake mission ${missionId}`)
        const expected = currentAwakeMissionState(playerId, missionId)
        assert.equal(entry.progress_value, expected.progress)
        assert.equal(entry.stage, expected.stage)
    }
}

async function completeLavuAwakeMissions(app, player, playId) {
    prepareLavuAwakeFacts(player.playerId)
    const preBattleProgress = await getLavuAwakePage(app, player)
    assertAwakeProgressResponseMatchesDb(player.playerId, preBattleProgress)
    syncClientWithDb(player, preBattleProgress, { missions: true })
    const preBattleMissions = getPlayerCategoryMissionsSync(player.playerId, 9)
    assert.deepEqual(preBattleMissions[2630021], { progress: 3, stages: { 1: true } })
    assert.deepEqual(preBattleMissions[2630022], {
        progress: LAVU_AWAKE_MANA_TARGET,
        stages: { 1: true },
    })
    assert.deepEqual(persistedAwakeMap(player.playerId), {})

    insertActiveQuest(player.playerId, {
        questId: LAVU_CHALLENGE_QUEST_ID,
        category: LAVU_CHALLENGE_CATEGORY,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        playId,
        continueCount: 0,
    })
    const data = await post(app, "/api/index.php/single_battle_quest/finish", {
        viewer_id: player.viewerId,
        api_count: 1,
        play_id: playId,
        quest_id: LAVU_CHALLENGE_QUEST_ID,
        category: LAVU_CHALLENGE_CATEGORY,
        score: 0,
        elapsed_time_ms: 1000,
        add_mana: 0,
        is_accomplished: true,
        is_restored: false,
        continue_count: 0,
        statistics: {
            clear_phase: 1,
            max_combo_count: 0,
            zones: [{
                damage_deal_total: 0,
                members: [{ origin_damage: 0 }, null, null],
            }],
            party: {
                characters: [{ id: BARETTA_ID }, null, null],
                unison_characters: [null, null, null],
                equipments: [null, null, null],
                ability_soul_ids: [null, null, null],
            },
        },
    })
    syncClientWithDb(player, data, { missions: false })
    assert.deepEqual(persistedAwakeMap(player.playerId), { 1: 1 })
    const finalProgress = await getLavuAwakePage(app, player)
    assertAwakeProgressResponseMatchesDb(player.playerId, finalProgress)
    syncClientWithDb(player, finalProgress, { missions: true })
    const missions = getPlayerCategoryMissionsSync(player.playerId, 9)
    assert.equal(missions[2630022].progress >= LAVU_AWAKE_MANA_TARGET, true)
    assert.deepEqual(missions[2630023], { progress: 1, stages: { 1: true } })
    assert.deepEqual(missions[2630024], { progress: 3, stages: { 1: true } })
}

async function awakeBoardOne(app, player) {
    const nodeIds = orderedBoardNodeIds(1)
    await runCommandStep(
        app,
        player,
        "awake_mana_nodes",
        "/api/index.php/character/awake_mana_node",
        {
            character_id: LAVU_ID,
            mana_node_multiplied_id_list: nodeIds,
            awake_level: 1,
        },
        result => {
            assert.deepEqual([...result.changedNodeIds].sort((a, b) => a - b), [...nodeIds].sort((a, b) => a - b))
            assert.equal([...result.after.normalManaNodes.values()].filter(level => level === 1).length, nodeIds.length)
        },
    )
}

function finalState(player) {
    const character = getPlayerCharacterSync(player.playerId, LAVU_ID)
    const storedPlayer = getPlayerSync(player.playerId)
    return {
        character: {
            exp: character.exp,
            overLimitStep: character.overLimitStep,
            evolutionLevel: character.evolutionLevel,
            manaBoardIndex: character.manaBoardIndex,
            bondTokens: sortedTokenList(character.bondTokenList),
        },
        normalManaNodes: sortedEntries(
            getPlayerCharacterManaNodeAwakeLevelsSync(player.playerId, LAVU_ID),
        ),
        awakeUnlocks: sortedEntries(persistedAwakeMap(player.playerId)),
        bondTokenDelta: storedPlayer.bondToken - player.initialBondToken,
        resources: {
            freeMana: storedPlayer.freeMana,
            paidMana: storedPlayer.paidMana,
            items: getPlayerItemsSync(player.playerId),
        },
        awakeMissions: Object.fromEntries(LAVU_AWAKE_MISSION_IDS.map(missionId => [
            missionId,
            getPlayerCategoryMissionsSync(player.playerId, 9)[missionId],
        ])),
    }
}

async function runOrdering(app, player, awakeBeforeSecondBoard) {
    await learnBoard(app, player, 1)
    await receiveBoardToken(app, player, 1)

    if (awakeBeforeSecondBoard) {
        await completeLavuAwakeMissions(app, player, `lavu-awake-first-${player.playerId}`)
        await awakeBoardOne(app, player)
    }

    await openSecondBoard(app, player)
    await openSecondBoard(app, player, true)
    await learnBoard(app, player, 2)
    await receiveBoardToken(app, player, 2)
    await receiveBoardToken(app, player, 2, true)

    if (!awakeBeforeSecondBoard) {
        await completeLavuAwakeMissions(app, player, `lavu-board-two-first-${player.playerId}`)
        await awakeBoardOne(app, player)
    }

    const loadData = await post(app, "/api/index.php/load", {
        viewer_id: player.viewerId,
        keychain: player.viewerId,
        device_id: player.viewerId,
        device_token: "character-growth-gate",
        graphics_device_name: "test",
        platform_os_version: "test",
        storage_directory_path: "test",
    })
    assertAwakeLoadMatchesDb(player.playerId, loadData)
    const loadedClient = clientStateFromLoad(loadData, player.growthItemIds)
    assertClientMatchesDb(player.playerId, loadedClient, { missions: true })
    return finalState(player)
}

test("CN-reachable Lavu Awake-first and board-two-first orderings converge", async () => {
    const app = await createApp()
    try {
        const awakeFirst = await createReachablePlayer()
        const boardTwoFirst = await createReachablePlayer()
        const awakeFirstFinal = await runOrdering(app, awakeFirst, true)
        const boardTwoFirstFinal = await runOrdering(app, boardTwoFirst, false)

        assert.equal(awakeFirstFinal.character.manaBoardIndex, 2)
        assert.deepEqual(awakeFirstFinal.character.bondTokens, [
            { mana_board_index: 1, status: 2 },
            { mana_board_index: 2, status: 2 },
        ])
        assert.deepEqual(awakeFirstFinal.awakeUnlocks, [[1, 1]])
        assert.equal(awakeFirstFinal.bondTokenDelta, 2)
        const boardOneIds = new Set(Object.keys(getCharacterManaNodesSync(LAVU_ID, 1)).map(Number))
        const boardTwoIds = new Set(Object.keys(getCharacterManaNodesSync(LAVU_ID, 2)).map(Number))
        assert.equal(
            awakeFirstFinal.normalManaNodes.every(([nodeId, level]) => (
                boardOneIds.has(nodeId) ? level === 1 : boardTwoIds.has(nodeId) && level === 0
            )),
            true,
        )
        assert.deepEqual(boardTwoFirstFinal, awakeFirstFinal)
    } finally {
        await app.close()
    }
})

test.after(() => {
    for (const restore of patchedCommands.reverse()) restore()
    setServerTimeOffset(previousTimeOffset)
    fixture.cleanup()
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
