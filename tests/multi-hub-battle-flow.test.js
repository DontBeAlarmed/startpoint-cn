"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const Database = require("better-sqlite3")

const {
    BOSS_QUEST,
    buildFinishPayload,
    buildRoomParty,
    buildStartPayload,
    completeScene,
    finishPlayer,
    leaveLobbyForBattle,
    normalizedRoomOutcome,
    openBattlePeers,
    openRoomParty,
    playerState,
    signUp,
} = require("./helpers/multi-hub-battle-flow")
const { createBehaviorSignature } = require("../tools/perf/multi_hub_load_metrics.cjs")

function createIdentityDatabase() {
    const database = new Database(":memory:")
    database.exec(`
        CREATE TABLE sessions (token TEXT NOT NULL, account_id INTEGER NOT NULL);
        CREATE TABLE players (id INTEGER NOT NULL, account_id INTEGER NOT NULL);
    `)
    return database
}

function signupHarness(database, response) {
    return {
        gamePost: async () => response,
        withDatabase(_dataKey, operation) {
            return operation(database)
        },
    }
}

function createSettlementDatabase() {
    const database = new Database(":memory:")
    database.exec(`
        CREATE TABLE players (
            id INTEGER PRIMARY KEY,
            stamina INTEGER NOT NULL,
            boost_point INTEGER NOT NULL,
            boss_boost_point INTEGER NOT NULL,
            vmoney INTEGER NOT NULL,
            free_vmoney INTEGER NOT NULL,
            free_mana INTEGER NOT NULL,
            paid_mana INTEGER NOT NULL,
            rank_point INTEGER NOT NULL,
            star_crumb INTEGER NOT NULL,
            bond_token INTEGER NOT NULL,
            exp_pool INTEGER NOT NULL,
            degree_id INTEGER NOT NULL,
            total_stamina_used INTEGER NOT NULL,
            total_powerflips INTEGER NOT NULL,
            total_dashes INTEGER NOT NULL,
            total_mana_obtained INTEGER NOT NULL,
            max_combo_achieved INTEGER NOT NULL
        );
        CREATE TABLE players_items (
            id INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            player_id INTEGER NOT NULL,
            PRIMARY KEY (id, player_id)
        );
        CREATE TABLE players_quest_progress (
            section INTEGER NOT NULL,
            quest_id INTEGER NOT NULL,
            finished INTEGER NOT NULL,
            unlocked INTEGER NOT NULL,
            high_score INTEGER,
            clear_rank INTEGER,
            best_elapsed_time_ms INTEGER,
            leader_character_id INTEGER,
            multi_clear_count INTEGER NOT NULL,
            host_finished INTEGER,
            player_id INTEGER NOT NULL,
            PRIMARY KEY (section, quest_id, player_id)
        );
        CREATE TABLE players_mission_battle_counters (
            player_id INTEGER PRIMARY KEY,
            single_play_count INTEGER NOT NULL,
            single_clear_count INTEGER NOT NULL,
            multi_play_count INTEGER NOT NULL,
            multi_clear_count INTEGER NOT NULL,
            multi_host_clear_count INTEGER NOT NULL,
            multi_guest_clear_count INTEGER NOT NULL,
            single_rank_ss_count INTEGER NOT NULL,
            rank_ss_count INTEGER NOT NULL,
            rank_s_count INTEGER NOT NULL,
            rank_a_count INTEGER NOT NULL,
            rank_b_count INTEGER NOT NULL,
            challenge_dungeon_clear_count INTEGER NOT NULL,
            single_score_max INTEGER NOT NULL,
            single_clear_time_min INTEGER NOT NULL,
            boss_battle_clear_count INTEGER NOT NULL,
            skill_use_count INTEGER NOT NULL
        );
        CREATE TABLE players_active_missions (
            id INTEGER NOT NULL,
            progress INTEGER NOT NULL,
            player_id INTEGER NOT NULL,
            PRIMARY KEY (id, player_id)
        );
        CREATE TABLE players_active_missions_stages (
            id INTEGER NOT NULL,
            status INTEGER NOT NULL,
            player_id INTEGER NOT NULL,
            mission_id INTEGER NOT NULL,
            PRIMARY KEY (id, mission_id, player_id)
        );
        CREATE TABLE players_active_quests (
            player_id INTEGER PRIMARY KEY,
            play_id TEXT NOT NULL,
            quest_id INTEGER NOT NULL,
            category INTEGER NOT NULL,
            use_boss_boost_point INTEGER NOT NULL,
            use_boost_point INTEGER NOT NULL,
            is_auto_start_mode INTEGER NOT NULL,
            is_multi INTEGER NOT NULL,
            coordinator_origin TEXT,
            room_number TEXT,
            battle_session_id TEXT,
            entry_item_id INTEGER,
            entry_item_count INTEGER,
            event_id INTEGER,
            continue_count INTEGER NOT NULL
        );
        INSERT INTO players (
            id, stamina, boost_point, boss_boost_point, vmoney, free_vmoney,
            free_mana, paid_mana, rank_point, star_crumb, bond_token, exp_pool,
            degree_id, total_stamina_used, total_powerflips, total_dashes,
            total_mana_obtained, max_combo_achieved
        ) VALUES (2, 64, 3, 2, 11, 12, 2290, 17, 439, 13, 14, 15, 16, 18, 19, 20, 21, 22);
        INSERT INTO players_items (id, amount, player_id) VALUES (10, 4, 2), (20, 7, 2);
        INSERT INTO players_quest_progress (
            section, quest_id, finished, unlocked, high_score, clear_rank,
            best_elapsed_time_ms, leader_character_id, multi_clear_count,
            host_finished, player_id
        ) VALUES (2, 1001002, 1, 1, 0, 1, 1000, 1, 1, 1, 2);
        INSERT INTO players_mission_battle_counters VALUES (
            2, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1
        );
        INSERT INTO players_active_missions (id, progress, player_id) VALUES (7, 1, 2);
        INSERT INTO players_active_missions_stages (id, status, player_id, mission_id)
            VALUES (1, 2, 2, 7);
    `)
    return database
}

function settlementHarness(database, { mutateDuplicate, responses, neverAt } = {}) {
    const requests = []
    let calls = 0
    return {
        requests,
        async gamePost(url, route, payload) {
            calls++
            requests.push({ url, route, payload })
            if (calls === neverAt) return new Promise(() => {})
            if (calls === 2) mutateDuplicate?.(database)
            return responses?.[calls - 1] ?? (calls === 1
                ? { status: 200, body: { data_headers: { result_code: 1 } } }
                : { status: 400, body: { data_headers: { result_code: 4 } } })
        },
        withDatabase(_dataKey, operation) {
            return operation(database)
        },
    }
}

function finishOptions(timeoutMs = 50) {
    return {
        roomNumber: 123456,
        quest: BOSS_QUEST,
        playId: "play-1",
        timeoutMs,
    }
}

const SENSITIVE_PROTOCOL_VALUES = Object.freeze([
    "viewer-sensitive-value",
    "login-token-sensitive-value",
    "mate-snapshot-sensitive-value",
    "raw-frame-sensitive-value",
])

function rawProtocolError() {
    return new Error(`timed out waiting for peer: ${JSON.stringify({
        viewer_id: SENSITIVE_PROTOCOL_VALUES[0],
        login_token: SENSITIVE_PROTOCOL_VALUES[1],
        mate_snapshot: SENSITIVE_PROTOCOL_VALUES[2],
        raw_frame: SENSITIVE_PROTOCOL_VALUES[3],
    })}`)
}

function assertSanitizedErrorGraph(error) {
    const seen = new Set()
    const visit = current => {
        if (current === undefined || current === null || seen.has(current)) return
        assert.equal(current instanceof Error, true)
        seen.add(current)
        assert.match(
            current.message,
            /^[a-z]+(?: [a-z]+)*(?: cleanup [1-9][0-9]*)? (?:failed|timed out)$/,
        )
        const visible = `${current.message}\n${current.stack ?? ""}`
        for (const secret of SENSITIVE_PROTOCOL_VALUES) {
            assert.doesNotMatch(visible, new RegExp(secret))
        }
        assert.doesNotMatch(
            visible,
            /viewer_id|login_token|mate_snapshot|raw_frame|\{"|"\}/,
        )
        if (current instanceof AggregateError) {
            for (const nested of current.errors) visit(nested)
        }
        visit(current.cause)
    }
    visit(error)
}

function fakePeer({
    waitFailureAt,
    waitFailure = new Error("handshake failed"),
    closeFailure,
    closePromise,
    closeThrows,
    closedPromise = Promise.resolve(),
} = {}) {
    let waits = 0
    return {
        closeCalls: 0,
        closedPromise,
        sent: [],
        close() {
            this.closeCalls++
            if (closeThrows) throw closeThrows
            if (closePromise) return closePromise
            return closeFailure ? Promise.reject(closeFailure) : Promise.resolve()
        },
        send(message) {
            this.sent.push(message)
        },
        waitFor() {
            waits++
            return waits === waitFailureAt
                ? Promise.reject(waitFailure)
                : Promise.resolve()
        },
    }
}

function preparedResponse(roomNumber) {
    return {
        status: 200,
        body: {
            data: {
                room_number: roomNumber,
                ip_address: "127.0.0.1",
                port: 8003,
            },
        },
    }
}

test("BOSS_QUEST keeps the real CN boss quest identity", () => {
    assert.deepEqual(BOSS_QUEST, { category: 2, questId: 1001002 })
})

test("buildRoomParty keeps CN Option wrappers and session party field names", () => {
    assert.deepEqual(buildRoomParty(), {
        characters: [[0, {
            id: 1,
            evolution_level: 0,
            exp: 10,
            over_limit_step: 0,
            mana_node_ids: {},
            ex_boost: [1],
            illustration_settings: [1],
        }], [1], [1]],
        unison_characters: [[1], [1], [1]],
        equipments: [[1], [1], [1]],
        abilitySoulIds: [[1], [1], [1]],
    })
})

test("buildStartPayload keeps the CN multiplayer start fields", () => {
    assert.deepEqual(buildStartPayload(
        { viewerId: "viewer-1" },
        123456,
        BOSS_QUEST,
        "play-1",
    ), {
        viewer_id: "viewer-1",
        api_count: 1,
        quest_id: 1001002,
        category: 2,
        party_id: 1,
        use_boost_point: false,
        use_boss_boost_point: false,
        is_auto_start_mode: false,
        room_number: 123456,
        mate_player_ids: [],
        mate_party_ids: [],
        play_id: "play-1",
        combat_power: 1,
    })
})

test("buildFinishPayload keeps CN fields and statistics.party", () => {
    assert.deepEqual(buildFinishPayload(
        { viewerId: "viewer-1" },
        123456,
        BOSS_QUEST,
        "play-1",
    ), {
        viewer_id: "viewer-1",
        api_count: 1,
        quest_id: 1001002,
        category: 2,
        room_number: 123456,
        play_id: "play-1",
        score: 0,
        elapsed_time_ms: 1_000,
        add_mana: 0,
        is_accomplished: true,
        continue_count: 0,
        statistics: {
            clear_phase: 1,
            max_combo_count: 0,
            zones: [{ use_power_flip_count: 1 }],
            party: {
                characters: [{ id: 1 }, null, null],
                unison_characters: [null, null, null],
                equipments: [null, null, null],
                ability_soul_ids: [null, null, null],
            },
        },
        mate_player_result: [],
    })
})

test("normalizedRoomOutcome returns only canonical behavior fields", () => {
    const source = {
        ownerSide: "client",
        hostRewarded: true,
        guestRewarded: false,
        duplicateFinishRejected: 2,
    }
    const normalized = normalizedRoomOutcome(source)

    assert.deepEqual(normalized, source)
    assert.deepEqual(Object.keys(normalized), [
        "ownerSide",
        "hostRewarded",
        "guestRewarded",
        "duplicateFinishRejected",
    ])
    assert.notEqual(normalized, source)
    assert.equal(Object.isFrozen(normalized), true)
    assert.equal(
        createBehaviorSignature(normalized),
        "sha256:1173bc6067757736cd4b49d4d98e22ad7b3bef9b8f5b932930c9449611cacc28",
    )
})

test("normalizedRoomOutcome rejects invalid values and unknown dynamic fields", () => {
    const valid = {
        ownerSide: "host",
        hostRewarded: true,
        guestRewarded: true,
        duplicateFinishRejected: 2,
    }
    for (const invalid of [
        null,
        { ...valid, ownerSide: "server" },
        { ...valid, hostRewarded: 1 },
        { ...valid, guestRewarded: "true" },
        { ...valid, duplicateFinishRejected: -1 },
        { ...valid, duplicateFinishRejected: 1.5 },
        { ...valid, duplicateFinishRejected: Number.MAX_SAFE_INTEGER + 1 },
        { ...valid, roomNumber: 123456 },
    ]) {
        assert.throws(() => normalizedRoomOutcome(invalid), TypeError)
    }
})

test("normalizedRoomOutcome requires own enumerable data fields on a plain object", () => {
    const valid = {
        ownerSide: "host",
        hostRewarded: true,
        guestRewarded: true,
        duplicateFinishRejected: 2,
    }
    const accessor = { ...valid }
    Object.defineProperty(accessor, "ownerSide", {
        enumerable: true,
        get: () => "host",
    })
    const inherited = Object.assign(Object.create({ ownerSide: "host" }), valid)
    delete inherited.ownerSide
    const symbolField = { ...valid, [Symbol("dynamic")]: true }
    for (const invalid of [accessor, inherited, symbolField, new Date()]) {
        assert.throws(() => normalizedRoomOutcome(invalid), TypeError)
    }
})

test("normalizedRoomOutcome rejects Proxy input before traps run", () => {
    let traps = 0
    const target = {
        ownerSide: "host",
        hostRewarded: true,
        guestRewarded: true,
        duplicateFinishRejected: 2,
        rawPayload: "dynamic",
    }
    const outcome = new Proxy(target, {
        ownKeys() {
            traps++
            return Reflect.ownKeys(target).filter(key => key !== "rawPayload")
        },
    })

    assert.throws(() => normalizedRoomOutcome(outcome), TypeError)
    assert.equal(traps, 0)
})

test("signUp resolves the player through the returned viewer session", async t => {
    const database = createIdentityDatabase()
    t.after(() => database.close())
    database.exec(`
        INSERT INTO sessions (token, account_id) VALUES ('viewer-1', 11), ('viewer-2', 22);
        INSERT INTO players (id, account_id) VALUES (1, 11), (2, 22);
    `)
    const harness = signupHarness(database, {
        status: 200,
        body: { data_headers: { viewer_id: "viewer-2" } },
    })
    const node = { dataKey: "identity" }

    await signUp(harness, node, 10002)

    assert.equal(node.viewerId, "viewer-2")
    assert.equal(node.playerId, 2)
})

test("signUp rejects zero or multiple session-owned players with finite errors", async t => {
    const zero = createIdentityDatabase()
    const multiple = createIdentityDatabase()
    t.after(() => zero.close())
    t.after(() => multiple.close())
    zero.exec(`
        INSERT INTO sessions (token, account_id) VALUES ('viewer-2', 22);
    `)
    multiple.exec(`
        INSERT INTO sessions (token, account_id) VALUES ('viewer-2', 22);
        INSERT INTO players (id, account_id) VALUES (2, 22), (3, 22);
    `)
    const response = {
        status: 200,
        body: { data_headers: { viewer_id: "viewer-2" } },
    }

    for (const database of [zero, multiple]) {
        await assert.rejects(
            signUp(signupHarness(database, response), { dataKey: "identity" }, 10002),
            error => error instanceof Error
                && error.message === "signup player lookup failed",
        )
    }
})

test("signUp HTTP failures expose only stage, status, and finite result code", async () => {
    const secrets = [
        "viewer-secret",
        "login-token-secret",
        "device-secret",
        "raw-payload-secret",
    ]
    const response = {
        status: 503,
        body: {
            data_headers: { result_code: 4507, viewer_id: secrets[0] },
            login_token: secrets[1],
            device_id: secrets[2],
            raw_payload: secrets[3],
        },
    }

    await assert.rejects(
        signUp({ gamePost: async () => response }, { dataKey: "identity" }, 10002),
        error => {
            assert.equal(error.message, "signup failed: HTTP 503, result_code 4507")
            for (const secret of secrets) assert.doesNotMatch(error.message, new RegExp(secret))
            assert.doesNotMatch(error.message, /viewer_id|login_token|device_id|raw_payload/)
            return true
        },
    )
})

test("playerState queries tickets only when a valid ticketItemId option is provided", t => {
    const database = new Database(":memory:")
    t.after(() => database.close())
    database.exec(`
        CREATE TABLE players (
            id INTEGER PRIMARY KEY,
            stamina INTEGER NOT NULL,
            free_mana INTEGER NOT NULL,
            rank_point INTEGER NOT NULL
        );
        CREATE TABLE players_active_quests (player_id INTEGER NOT NULL);
        INSERT INTO players (id, stamina, free_mana, rank_point) VALUES (2, 80, 900, 40);
        INSERT INTO players_active_quests (player_id) VALUES (2);
    `)
    const harness = {
        withDatabase(_dataKey, operation) {
            return operation(database)
        },
    }
    const node = { dataKey: "identity", playerId: 2 }

    assert.deepEqual(playerState(harness, node), {
        stamina: 80,
        freeMana: 900,
        rankPoint: 40,
        activeQuests: 1,
    })
    database.exec(`
        CREATE TABLE players_items (player_id INTEGER NOT NULL, id INTEGER NOT NULL, amount INTEGER NOT NULL);
        INSERT INTO players_items (player_id, id, amount) VALUES (2, 500000, 3);
    `)
    assert.deepEqual(playerState(harness, node, { ticketItemId: 500000 }), {
        stamina: 80,
        freeMana: 900,
        rankPoint: 40,
        ticket: 3,
        activeQuests: 1,
    })
    for (const ticketItemId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(
            () => playerState(harness, node, { ticketItemId }),
            /player state validation failed/,
        )
    }
})

test("finishPlayer requires first success, rejects duplicate, and reuses one payload", async t => {
    const database = createSettlementDatabase()
    t.after(() => database.close())
    const harness = settlementHarness(database)
    const node = {
        dataKey: "identity",
        playerId: 2,
        url: "http://game.invalid",
        viewerId: "viewer-1",
    }

    const state = await finishPlayer(harness, node, finishOptions())

    assert.deepEqual(state.player, {
        stamina: 64,
        boostPoint: 3,
        bossBoostPoint: 2,
        vmoney: 11,
        freeVmoney: 12,
        freeMana: 2290,
        paidMana: 17,
        rankPoint: 439,
        starCrumb: 13,
        bondToken: 14,
        expPool: 15,
        degreeId: 16,
        totalStaminaUsed: 18,
        totalPowerflips: 19,
        totalDashes: 20,
        totalManaObtained: 21,
        maxComboAchieved: 22,
    })
    assert.deepEqual(state.activeQuests, [])
    assert.equal(harness.requests.length, 2)
    assert.equal(harness.requests[0].route, "/api/index.php/multi_battle_quest/finish")
    assert.strictEqual(harness.requests[1].payload, harness.requests[0].payload)
    assert.deepEqual(harness.requests[0].payload, buildFinishPayload(
        node,
        123456,
        BOSS_QUEST,
        "play-1",
    ))
})

test("finishPlayer rejects an unsuccessful first finish and successful duplicate", async t => {
    const cases = [
        [
            { status: 200, body: { data_headers: { result_code: 4 } } },
            { status: 400, body: { data_headers: { result_code: 4 } } },
            "finish response failed",
        ],
        [
            { status: 200, body: { data_headers: { result_code: 1 } } },
            { status: 200, body: { data_headers: { result_code: 1 } } },
            "duplicate finish response failed",
        ],
    ]
    for (const [first, duplicate, expected] of cases) {
        const database = createSettlementDatabase()
        t.after(() => database.close())
        const harness = settlementHarness(database, { responses: [first, duplicate] })
        await assert.rejects(
            finishPlayer(harness, {
                dataKey: "identity",
                playerId: 2,
                url: "http://game.invalid",
                viewerId: "viewer-1",
            }, finishOptions()),
            error => error.message === expected,
        )
    }
})

test("finishPlayer detects duplicate-only settlement fact mutations", async t => {
    const mutations = [
        database => database.prepare(`
            UPDATE players_items SET amount = amount + 1 WHERE player_id = 2 AND id = 10
        `).run(),
        database => database.prepare(`
            UPDATE players_active_missions SET progress = progress + 1
            WHERE player_id = 2 AND id = 7
        `).run(),
        database => database.prepare(`
            UPDATE players_quest_progress SET multi_clear_count = multi_clear_count + 1
            WHERE player_id = 2 AND section = 2 AND quest_id = 1001002
        `).run(),
        database => database.prepare(`
            UPDATE players SET exp_pool = exp_pool + 1 WHERE id = 2
        `).run(),
        database => database.prepare(`
            UPDATE players SET boost_point = boost_point + 1 WHERE id = 2
        `).run(),
        database => database.prepare(`
            UPDATE players SET boss_boost_point = boss_boost_point + 1 WHERE id = 2
        `).run(),
        database => database.prepare(`
            UPDATE players SET total_mana_obtained = total_mana_obtained + 1 WHERE id = 2
        `).run(),
    ]
    for (const mutateDuplicate of mutations) {
        const database = createSettlementDatabase()
        t.after(() => database.close())
        const harness = settlementHarness(database, { mutateDuplicate })
        await assert.rejects(
            finishPlayer(harness, {
                dataKey: "identity",
                playerId: 2,
                url: "http://game.invalid",
                viewerId: "viewer-1",
            }, finishOptions()),
            error => error.message === "duplicate finish state failed",
        )
    }
})

test("finishPlayer bounds first and duplicate requests", async t => {
    for (const neverAt of [1, 2]) {
        const database = createSettlementDatabase()
        t.after(() => database.close())
        const harness = settlementHarness(database, { neverAt })
        await assert.rejects(
            Promise.race([
                finishPlayer(harness, {
                    dataKey: "identity",
                    playerId: 2,
                    url: "http://game.invalid",
                    viewerId: "viewer-1",
                }, finishOptions(10)),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error("test observed unbounded finish")),
                    50,
                )),
            ]),
            error => error.message === (neverAt === 1
                ? "finish request timed out"
                : "duplicate finish request timed out"),
        )
    }
})

test("finishPlayer sanitizes raw request errors", async t => {
    for (const failureAt of [1, 2]) {
        const database = createSettlementDatabase()
        t.after(() => database.close())
        let calls = 0
        const harness = settlementHarness(database, {
            responses: [
                { status: 200, body: { data_headers: { result_code: 1 } } },
                { status: 400, body: { data_headers: { result_code: 4 } } },
            ],
        })
        const original = harness.gamePost
        harness.gamePost = (...args) => {
            calls++
            if (calls === failureAt) throw rawProtocolError()
            return original(...args)
        }
        await assert.rejects(
            finishPlayer(harness, {
                dataKey: "identity",
                playerId: 2,
                url: "http://game.invalid",
                viewerId: SENSITIVE_PROTOCOL_VALUES[0],
            }, finishOptions()),
            error => {
                assertSanitizedErrorGraph(error)
                assert.equal(error.message, failureAt === 1
                    ? "finish request failed"
                    : "duplicate finish request failed")
                return true
            },
        )
    }
})

test("openRoomParty closes partial lobby peers and disbands after guest handshake failure", async () => {
    const roomNumber = 246810
    const hostPeer = fakePeer()
    const guestPeer = fakePeer({ waitFailureAt: 1, waitFailure: rawProtocolError() })
    const peers = [hostPeer, guestPeer]
    let disbandCalls = 0
    const harness = {
        async gamePost(_url, path) {
            if (path.endsWith("/create_room")) {
                return { status: 200, body: { data: { room_number: roomNumber } } }
            }
            if (path.endsWith("/search_room")) {
                return { status: 200, body: { data: { room_exists: true } } }
            }
            if (path.endsWith("/select_room")) return preparedResponse(roomNumber)
            if (path.endsWith("/disband_room")) {
                disbandCalls++
                return { status: 200, body: {} }
            }
            throw new Error("unexpected route")
        },
        async openTcp() {
            return peers.shift()
        },
    }
    const nodes = [
        { dataKey: "host-dynamic", url: "host", viewerId: "viewer-host-dynamic" },
        { dataKey: "guest-dynamic", url: "guest", viewerId: "viewer-guest-dynamic" },
    ]

    await assert.rejects(
        openRoomParty(harness, nodes, BOSS_QUEST, "partial"),
        error => {
            assertSanitizedErrorGraph(error)
            assert.equal(error.message, "lobby handshake failed")
            return true
        },
    )
    assert.equal(hostPeer.closeCalls, 1)
    assert.equal(guestPeer.closeCalls, 1)
    assert.equal(disbandCalls, 1)
})

test("openBattlePeers closes every opened peer after the second handshake fails", async () => {
    const first = fakePeer()
    const second = fakePeer({ waitFailureAt: 1, waitFailure: rawProtocolError() })
    const peers = [first, second]
    const harness = {
        async openTcp() {
            return peers.shift()
        },
    }
    const lobby = [first, second].map((peer, index) => ({
        connectionId: `connection-dynamic-${index}`,
        endpoint: { host: "127.0.0.1", port: 8003 },
        peer,
    }))

    await assert.rejects(
        openBattlePeers(harness, lobby, 246810, "battle-dynamic"),
        error => {
            assertSanitizedErrorGraph(error)
            assert.equal(error.message, "battle handshake failed")
            return true
        },
    )
    assert.equal(first.closeCalls, 1)
    assert.equal(second.closeCalls, 1)
})

test("openBattlePeers retains the handshake error when cleanup also fails", async () => {
    const cleanupFailure = rawProtocolError()
    const first = fakePeer({ closeFailure: cleanupFailure })
    const second = fakePeer({ waitFailureAt: 1, waitFailure: rawProtocolError() })
    const peers = [first, second]
    const harness = {
        async openTcp() {
            return peers.shift()
        },
    }
    const lobby = [first, second].map((_peer, index) => ({
        connectionId: `connection-${index}`,
        endpoint: { host: "127.0.0.1", port: 8003 },
    }))

    await assert.rejects(
        openBattlePeers(harness, lobby, 246810, "battle"),
        error => {
            assertSanitizedErrorGraph(error)
            assert.equal(error instanceof AggregateError, true)
            assert.equal(error.message, "battle handshake failed")
            assert.equal(error.cause?.message, "battle handshake failed")
            assert.deepEqual(error.errors.map(item => item.message), [
                "battle handshake failed",
                "open battle peers cleanup 1 failed",
            ])
            return true
        },
    )
})

test("openBattlePeers sanitizes raw openTcp failures", async () => {
    const harness = {
        async openTcp() {
            throw rawProtocolError()
        },
    }
    const lobby = [{
        connectionId: "connection-dynamic",
        endpoint: { host: "host-dynamic", port: 8003 },
    }]

    await assert.rejects(
        openBattlePeers(harness, lobby, 246810, "battle-dynamic"),
        error => {
            assertSanitizedErrorGraph(error)
            assert.equal(error.message, "battle open failed")
            return true
        },
    )
})

test("openRoomParty and openBattlePeers pass validated nonzero openTcp timeouts", async () => {
    const roomNumber = 246810
    const lobbyPeer = fakePeer()
    const battlePeer = fakePeer()
    const observedTimeouts = []
    const harness = {
        async gamePost(_url, path) {
            if (path.endsWith("/create_room")) {
                return { status: 200, body: { data: { room_number: roomNumber } } }
            }
            if (path.endsWith("/select_room")) return preparedResponse(roomNumber)
            throw new Error("unexpected route")
        },
        async openTcp(_label, _host, _port, _handshake, timeoutMs) {
            observedTimeouts.push(timeoutMs)
            return observedTimeouts.length === 1 ? lobbyPeer : battlePeer
        },
    }
    const nodes = [{ dataKey: "host", url: "host", viewerId: "viewer" }]

    const party = await openRoomParty(harness, nodes, BOSS_QUEST, "timeout", "select", 17)
    await openBattlePeers(harness, party.lobby, roomNumber, "battle", 19)

    assert.deepEqual(observedTimeouts, [17, 19])
    for (const timeoutMs of observedTimeouts) {
        assert.equal(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, true)
    }
})

test("room and battle open timeout overrides require positive safe integers", async () => {
    const harness = {
        async openTcp() {
            assert.fail("invalid timeout reached openTcp")
        },
    }
    const lobby = [{
        connectionId: "connection",
        endpoint: { host: "127.0.0.1", port: 8003 },
    }]
    for (const timeoutMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(
            openBattlePeers(harness, lobby, 246810, "battle", timeoutMs),
            error => error instanceof TypeError
                && error.message === "battle timeout validation failed",
        )
        await assert.rejects(
            openRoomParty(harness, [], BOSS_QUEST, "room", "select", timeoutMs),
            error => error instanceof TypeError
                && error.message === "room timeout validation failed",
        )
    }
})

test("openBattlePeers bounds a never-settling openTcp call", async () => {
    const never = new Promise(() => {})
    const harness = {
        openTcp() {
            return never
        },
    }
    const lobby = [{
        connectionId: "connection",
        endpoint: { host: "127.0.0.1", port: 8003 },
    }]

    await assert.rejects(
        Promise.race([
            openBattlePeers(harness, lobby, 246810, "battle", 10),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error("test observed unbounded open")),
                50,
            )),
        ]),
        error => {
            assertSanitizedErrorGraph(error)
            assert.equal(error.message, "battle open timed out")
            return true
        },
    )
})

test("openBattlePeers bounds never-settling peer cleanup", async () => {
    const never = new Promise(() => {})
    const first = fakePeer({ closePromise: never })
    const second = fakePeer({ waitFailureAt: 1, waitFailure: rawProtocolError() })
    const peers = [first, second]
    const harness = {
        async openTcp() {
            return peers.shift()
        },
    }
    const lobby = [first, second].map((_peer, index) => ({
        connectionId: `connection-${index}`,
        endpoint: { host: "127.0.0.1", port: 8003 },
    }))

    await assert.rejects(
        Promise.race([
            openBattlePeers(harness, lobby, 246810, "battle", 10),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error("test observed unbounded battle cleanup")),
                50,
            )),
        ]),
        error => {
            assertSanitizedErrorGraph(error)
            assert.equal(error instanceof AggregateError, true)
            assert.deepEqual(error.errors.map(item => item.message), [
                "battle handshake failed",
                "open battle peers cleanup 1 timed out",
            ])
            return true
        },
    )
})

test("openRoomParty sanitizes prepared endpoint failures", async () => {
    const roomNumber = 246810
    let disbandCalls = 0
    const harness = {
        async gamePost(_url, path) {
            if (path.endsWith("/create_room")) {
                return { status: 200, body: { data: { room_number: roomNumber } } }
            }
            if (path.endsWith("/select_room")) {
                return preparedResponse(roomNumber + 1)
            }
            if (path.endsWith("/disband_room")) {
                disbandCalls++
                return { status: 200, body: {} }
            }
            throw new Error("unexpected route")
        },
    }

    await assert.rejects(
        openRoomParty(
            harness,
            [{ dataKey: "host-dynamic", url: "host-dynamic", viewerId: "viewer-dynamic" }],
            BOSS_QUEST,
            "endpoint-dynamic",
        ),
        error => {
            assertSanitizedErrorGraph(error)
            assert.equal(error.message, "lobby endpoint failed")
            assert.doesNotMatch(error.stack, /246810|246811|host-dynamic|viewer-dynamic/)
            return true
        },
    )
    assert.equal(disbandCalls, 1)
})

test("openRoomParty bounds never-settling disband cleanup", async () => {
    const roomNumber = 246810
    const never = new Promise(() => {})
    const harness = {
        async gamePost(_url, path) {
            if (path.endsWith("/create_room")) {
                return { status: 200, body: { data: { room_number: roomNumber } } }
            }
            if (path.endsWith("/select_room")) return preparedResponse(roomNumber + 1)
            if (path.endsWith("/disband_room")) return never
            throw new Error("unexpected route")
        },
    }

    await assert.rejects(
        Promise.race([
            openRoomParty(
                harness,
                [{ dataKey: "host", url: "host", viewerId: "viewer" }],
                BOSS_QUEST,
                "cleanup",
                "select",
                10,
            ),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error("test observed unbounded room cleanup")),
                50,
            )),
        ]),
        error => {
            assertSanitizedErrorGraph(error)
            assert.equal(error instanceof AggregateError, true)
            assert.deepEqual(error.errors.map(item => item.message), [
                "lobby endpoint failed",
                "open room party cleanup 1 timed out",
            ])
            return true
        },
    )
})

test("completeScene sanitizes raw peer wait failures", async () => {
    const peer = fakePeer({ waitFailureAt: 1, waitFailure: rawProtocolError() })

    await assert.rejects(
        completeScene([peer]),
        error => {
            assertSanitizedErrorGraph(error)
            assert.equal(error.message, "battle scene wait failed")
            return true
        },
    )
})

test("leaveLobbyForBattle bounds close waiting and actively closes timed out peers", async () => {
    const never = new Promise(() => {})
    const first = fakePeer({ closedPromise: never })
    const second = fakePeer({ closedPromise: never })

    await assert.rejects(
        Promise.race([
            leaveLobbyForBattle([{ peer: first }, { peer: second }], 10),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error("test observed unbounded leave wait")),
                50,
            )),
        ]),
        error => error.message === "leave lobby for battle timed out"
            && !/dynamic|connection|viewer|room/.test(error.message),
    )
    assert.equal(first.closeCalls, 1)
    assert.equal(second.closeCalls, 1)
})

test("leaveLobbyForBattle sanitizes timeout cleanup throws", async () => {
    const never = new Promise(() => {})
    const first = fakePeer({ closedPromise: never, closeThrows: rawProtocolError() })

    await assert.rejects(
        leaveLobbyForBattle([{ peer: first }], 10),
        error => {
            assertSanitizedErrorGraph(error)
            assert.equal(error instanceof AggregateError, true)
            assert.equal(error.message, "leave lobby for battle timed out")
            assert.equal(error.cause?.message, "leave lobby for battle timed out")
            assert.deepEqual(error.errors.map(item => item.message), [
                "leave lobby for battle timed out",
                "leave lobby for battle cleanup 1 failed",
            ])
            return true
        },
    )
})

test("leaveLobbyForBattle aggregates asynchronous cleanup rejection", async () => {
    const never = new Promise(() => {})
    const peer = fakePeer({
        closedPromise: never,
        closeFailure: rawProtocolError(),
    })

    await assert.rejects(
        leaveLobbyForBattle([{ peer }], 10, 10),
        error => {
            assertSanitizedErrorGraph(error)
            assert.equal(error instanceof AggregateError, true)
            assert.deepEqual(error.errors.map(item => item.message), [
                "leave lobby for battle timed out",
                "leave lobby for battle cleanup 1 failed",
            ])
            return true
        },
    )
    assert.equal(peer.closeCalls, 1)
})

test("leaveLobbyForBattle bounds never-settling cleanup", async () => {
    const never = new Promise(() => {})
    const peer = fakePeer({ closedPromise: never, closePromise: never })

    await assert.rejects(
        Promise.race([
            leaveLobbyForBattle([{ peer }], 10, 10),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error("test observed unbounded leave cleanup")),
                50,
            )),
        ]),
        error => {
            assertSanitizedErrorGraph(error)
            assert.equal(error instanceof AggregateError, true)
            assert.deepEqual(error.errors.map(item => item.message), [
                "leave lobby for battle timed out",
                "leave lobby for battle cleanup 1 timed out",
            ])
            return true
        },
    )
    assert.equal(peer.closeCalls, 1)
})
