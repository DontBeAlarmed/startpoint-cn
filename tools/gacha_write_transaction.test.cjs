"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const BetterSqlite3 = require("better-sqlite3")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gacha-write-tx-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot({ additionalTableNames: ["gacha.json"] })
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getActiveMissionCountersSync } = require("../src/data/domains/active_mission_counters")
const { getPlayerCharacterSync, getPlayerCharactersSync } = require("../src/data/domains/character")
const { getPlayerEquipmentSync, getPlayerEquipmentListSync } = require("../src/data/domains/equipment")
const { getPlayerGachaInfoSync, insertPlayerGachaInfoSync } = require("../src/data/domains/gacha")
const {
    getPlayerCollectedItemTotalSync,
    getPlayerItemSync,
    getPlayerItemsSync,
} = require("../src/data/domains/item")
const {
    grantInventoryFixtureItemSync,
    setInventoryFixtureItemExactSync,
} = require("./helpers/inventory-fixture.cjs")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const gachaRoutes = require("../src/routes/api/gacha").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { rewardPlayerGachaDrawResultSync } = require("../src/lib/gacha")
const { givePlayerCharacterSync } = require("../src/lib/character")
const { getPlayerMailsSync } = require("../src/data/domains/mail")
const { createRewardGrantItemOverflowPolicy } = require("../src/lib/reward-grant-item-overflow")
const { getDefaultGachaSeedQuarantine } = require("../src/lib/gacha-seed-quarantine")
const { GachaType, RewardType } = require("../src/lib/types")
const {
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
    createRewardGrantExecutionPlan,
} = require("../src/lib/reward-grant")
const {
    grantGachaRewardPlanInTransactionOwnerWithInventorySync,
} = require("../src/lib/gacha-reward-grant")
const { withDeferredInventoryBatchContextWithinTransactionSync } = require("../src/lib/inventory")

let database
let app
let nextViewerId = 860000000
const sqlTrace = { active: false, statements: [] }

function captureSql(operation) {
    sqlTrace.statements = []
    sqlTrace.active = true
    try {
        return { result: operation(), statements: [...sqlTrace.statements] }
    } finally {
        sqlTrace.active = false
    }
}

async function captureSqlAsync(operation) {
    sqlTrace.statements = []
    sqlTrace.active = true
    try {
        return { result: await operation(), statements: [...sqlTrace.statements] }
    } finally {
        sqlTrace.active = false
    }
}

async function captureGachaLogs(operation) {
    const originalLog = console.log
    const logs = []
    console.log = (...args) => {
        const message = args.map(String).join(" ")
        if (message.startsWith("[GACHA] reward_summary")) logs.push(message)
        originalLog(...args)
    }
    try {
        return { result: await operation(), logs }
    } finally {
        console.log = originalLog
    }
}

function rewardGrantPlayerSnapshot(playerId) {
    const player = getPlayerSync(playerId)
    return {
        playerId: player.id,
        freeMana: player.freeMana,
        freeVmoney: player.freeVmoney,
        expPool: player.expPool,
    }
}

async function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = nextViewerId++
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

function historyCount(playerId) {
    return database.prepare(`
        SELECT COUNT(*) AS count FROM players_receive_history WHERE player_id = ?
    `).get(playerId).count
}

function drawState(playerId, gachaId) {
    const player = getPlayerSync(playerId)
    return {
        freeVmoney: player.freeVmoney,
        vmoney: player.vmoney,
        characters: getPlayerCharactersSync(playerId),
        equipment: getPlayerEquipmentListSync(playerId),
        items: getPlayerItemsSync(playerId),
        gachaInfo: getPlayerGachaInfoSync(playerId, gachaId),
        historyCount: historyCount(playerId),
        activeMissionCounters: getActiveMissionCountersSync(playerId),
    }
}

test.before(async () => {
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath, {
            verbose: sql => { if (sqlTrace.active) sqlTrace.statements.push(sql) },
        }),
    })
    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    await app.register(gachaRoutes, { prefix: "/gacha" })
    await app.ready()
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("character pity exchange rolls reward back when history insertion fails", async t => {
    const { playerId, viewerId } = await createPlayer("gacha-character-exchange")
    insertPlayerGachaInfoSync(playerId, {
        gachaId: 29,
        isAccountFirst: false,
        isDailyFirst: false,
        gachaExchangePoint: 250,
    })
    database.exec(`
        CREATE TRIGGER reject_character_exchange_history
        BEFORE INSERT ON players_receive_history
        WHEN NEW.player_id = ${playerId} AND NEW.type_id = 151009
        BEGIN SELECT RAISE(ABORT, 'forced character exchange history failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_character_exchange_history"))

    const response = await app.inject({
        method: "POST",
        url: "/gacha/exchange_character",
        payload: {
            viewer_id: viewerId,
            gacha_id: 29,
            character_id: 151009,
            api_count: 1,
        },
    })

    assert.equal(response.statusCode, 500)
    assert.match(response.body, /forced character exchange history failure/)
    assert.equal(getPlayerCharacterSync(playerId, 151009), null)
    assert.equal(getPlayerGachaInfoSync(playerId, 29).gachaExchangePoint, 250)
    assert.equal(historyCount(playerId), 0)
})

test("equipment pity exchange rolls reward and history back when points fail", async t => {
    const { playerId, viewerId } = await createPlayer("gacha-equipment-exchange")
    insertPlayerGachaInfoSync(playerId, {
        gachaId: 5000,
        isAccountFirst: false,
        isDailyFirst: false,
        gachaExchangePoint: 250,
    })
    database.exec(`
        CREATE TRIGGER reject_equipment_exchange_points
        BEFORE UPDATE OF gacha_exchange_point ON players_gacha_info
        WHEN OLD.player_id = ${playerId} AND OLD.gacha_id = 5000
        BEGIN SELECT RAISE(ABORT, 'forced equipment exchange points failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_equipment_exchange_points"))

    const response = await app.inject({
        method: "POST",
        url: "/gacha/exchange_equipment",
        payload: {
            viewer_id: viewerId,
            gacha_id: 5000,
            equipment_id: 5040016,
            api_count: 1,
        },
    })

    assert.equal(response.statusCode, 500)
    assert.match(response.body, /forced equipment exchange points failure/)
    assert.equal(getPlayerEquipmentSync(playerId, 5040016), null)
    assert.equal(getPlayerGachaInfoSync(playerId, 5000).gachaExchangePoint, 250)
    assert.equal(historyCount(playerId), 0)
})

test("gacha exec rolls every persistent result back on late mission failure", async t => {
    const { playerId, viewerId } = await createPlayer("gacha-exec")
    updatePlayerSync({ id: playerId, freeVmoney: 1000, vmoney: 0 })
    const before = drawState(playerId, 1)
    database.exec(`
        CREATE TRIGGER reject_gacha_mission_counter
        BEFORE INSERT ON players_active_mission_counters
        WHEN NEW.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced gacha mission counter failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_gacha_mission_counter"))

    const routeSql = await captureSqlAsync(() => captureGachaLogs(() => app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: 1,
            payment_type: 1,
            number_of_exec: 1,
            type: 1,
            api_count: 1,
        },
    })))
    const captured = routeSql.result
    const response = captured.result

    assert.equal(response.statusCode, 500)
    assert.match(response.body, /forced gacha mission counter failure/)
    assert.deepEqual(drawState(playerId, 1), before)
    assert.deepEqual(captured.logs, [])
    assert.equal(
        routeSql.statements.filter(sql => /^\s*SELECT[\s\S]*\bFROM\s+players\b/i.test(sql)).length,
        2,
    )
    assert.equal(
        routeSql.statements.filter(sql => /^\s*(?:SAVEPOINT|RELEASE)\b/i.test(sql)).length,
        0,
    )
})

test("gacha exec commits charge reward history points and mission fact together", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-exec-success")
    updatePlayerSync({ id: playerId, freeVmoney: 1000, vmoney: 0 })

    const routeSql = await captureSqlAsync(() => captureGachaLogs(() => app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: 1,
            payment_type: 1,
            number_of_exec: 1,
            type: 1,
            api_count: 1,
        },
    })))
    const captured = routeSql.result
    const response = captured.result

    assert.equal(response.statusCode, 200, response.body)
    const after = drawState(playerId, 1)
    assert.equal(after.freeVmoney, 850)
    assert.equal(after.vmoney, 0)
    assert.equal(Object.keys(after.characters).length, 2)
    assert.equal(after.gachaInfo.gachaExchangePoint, 1)
    assert.equal(after.historyCount, 1)
    assert.equal(after.activeMissionCounters.totalGachaCharacterCount, 1)
    assert.equal(captured.logs.length, 1)
    assert.equal(
        routeSql.statements.filter(sql => /^\s*SELECT[\s\S]*\bFROM\s+players_items\b/i.test(sql)).length,
        0,
        "a first-character non-ticket draw must not activate deferred Inventory",
    )
    assert.equal(
        routeSql.statements.filter(sql => /^\s*INSERT\s+INTO\s+players_items\b/i.test(sql)).length,
        0,
    )
})

test("newbie ten-ticket gacha consumes the configured 70030 ticket", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-newbie-ten-ticket")
    grantInventoryFixtureItemSync(playerId, 70030, 1)
    const collectedBefore = getPlayerCollectedItemTotalSync(playerId, 70030)

    const routeSql = await captureSqlAsync(() => app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: 1613,
            payment_type: 3,
            number_of_exec: 1,
            type: 4,
            api_count: 1,
        },
    }))
    const response = routeSql.result

    assert.equal(response.statusCode, 200, response.body)
    const payload = require("msgpackr").unpack(Buffer.from(response.body, "base64"))
    assert.equal(getPlayerItemSync(playerId, 70030), 0)
    assert.equal(payload.data.item_list[70030], 0)
    assert.equal(payload.data.draw.length, 10)
    assert.equal(getPlayerGachaInfoSync(playerId, 1613).gachaExchangePoint, 10)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 70030), collectedBefore)
    const ticketWrites = routeSql.statements.filter(sql => (
        /^\s*INSERT\s+INTO\s+players_items\b/i.test(sql)
        && /VALUES\s*\(70030(?:\.0+)?,\s*0(?:\.0+)?,/i.test(sql)
    ))
    assert.equal(ticketWrites.length, 1, routeSql.statements.filter(sql => (
        /^\s*INSERT\s+INTO\s+players_items\b/i.test(sql)
    )).join("\n---\n"))
    const ticketCollectedWrites = routeSql.statements.filter(sql => (
        /^\s*INSERT\s+INTO\s+players_collected_items\b/i.test(sql)
        && /VALUES\s*\([^,]+,\s*70030(?:\.0+)?,/i.test(sql)
    ))
    assert.equal(ticketCollectedWrites.length, 0, ticketCollectedWrites.join("\n---\n"))
    assert.equal(
        routeSql.statements.filter(sql => /^\s*(?:SAVEPOINT|RELEASE)\b/i.test(sql)).length,
        0,
    )
})

test("ticket gacha rolls its ticket and rewards back on a late mission failure", async t => {
    const { playerId, viewerId } = await createPlayer("gacha-ticket-late-failure")
    grantInventoryFixtureItemSync(playerId, 70030, 1)
    const before = drawState(playerId, 1613)
    const collectedBefore = getPlayerCollectedItemTotalSync(playerId, 70030)
    database.exec(`
        CREATE TRIGGER reject_ticket_gacha_mission_counter
        BEFORE INSERT ON players_active_mission_counters
        WHEN NEW.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced ticket gacha mission counter failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_ticket_gacha_mission_counter"))

    const routeSql = await captureSqlAsync(() => app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: 1613,
            payment_type: 3,
            number_of_exec: 1,
            type: 4,
            api_count: 1,
        },
    }))
    const response = routeSql.result

    assert.equal(response.statusCode, 500)
    assert.match(response.body, /forced ticket gacha mission counter failure/)
    assert.deepEqual(drawState(playerId, 1613), before)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 70030), collectedBefore)
    assert.equal(
        routeSql.statements.filter(sql => (
            /^\s*INSERT\s+INTO\s+players_items\b/i.test(sql)
            && /VALUES\s*\(70030(?:\.0+)?,\s*0(?:\.0+)?,/i.test(sql)
        )).length,
        1,
        routeSql.statements.filter(sql => (
            /^\s*INSERT\s+INTO\s+players_items\b/i.test(sql)
        )).join("\n---\n"),
    )
    assert.equal(
        routeSql.statements.filter(sql => /^\s*(?:SAVEPOINT|RELEASE)\b/i.test(sql)).length,
        0,
    )
})

test("character duplicate gacha item_list reports the post-reward inventory", async () => {
    const { playerId } = await createPlayer("gacha-duplicate-item-list")
    const characterId = 1
    const exBoostItemId = 14002
    setInventoryFixtureItemExactSync(playerId, exBoostItemId, 20)

    const result = database.transaction(() => rewardPlayerGachaDrawResultSync(
        playerId,
        { type: GachaType.CHARACTER },
        [characterId],
        undefined,
        [{
            characterId,
            rarity: 4,
            movieId: "normal",
            seed: 1,
            requiresVerification: true,
        }],
        {
            ownerGrant: plan => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                playerId,
                plan,
                rewardGrantPlayerSnapshot(playerId),
            ),
        },
    ))()

    assert.equal(getPlayerItemSync(playerId, exBoostItemId), 21)
    assert.equal(result.draw[0].ex_boost_item.count, 1)
    assert.equal(result.items[exBoostItemId], 21)
})

test("gacha duplicate compensation sends capped overflow to Mail", async () => {
    const { playerId } = await createPlayer("gacha-capped-overflow")
    const characterId = 1
    const exBoostItemId = 14002
    givePlayerCharacterSync(playerId, characterId)
    const policy = createRewardGrantItemOverflowPolicy(playerId)
    setInventoryFixtureItemExactSync(playerId, exBoostItemId, policy.maxCount(exBoostItemId))

    const result = database.transaction(() => rewardPlayerGachaDrawResultSync(
        playerId,
        { type: GachaType.CHARACTER },
        [characterId],
        undefined,
        [{ characterId, rarity: 4, movieId: "normal", seed: 2, requiresVerification: true }],
        {
            ownerGrant: plan => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                playerId,
                plan,
                rewardGrantPlayerSnapshot(playerId),
                { itemOverflow: policy },
            ),
        },
    ))()

    assert.equal(result.draw[0].ex_boost_item.count, 0)
    assert.equal(result.items[exBoostItemId], policy.maxCount(exBoostItemId))
    const overflowMails = getPlayerMailsSync(playerId, 1, 100, true)
        .filter(mail => mail.type_id === exBoostItemId)
    assert.deepEqual(overflowMails.map(mail => mail.number), [1])
    assert.deepEqual(result.itemOverflowDispositions, [{
        kind: "mail",
        itemId: exBoostItemId,
        overflowAmount: 1,
    }])
})

test("gacha capped overflow rolls back with a later source failure", async () => {
    const { playerId } = await createPlayer("gacha-capped-overflow-rollback")
    const characterId = 1
    const exBoostItemId = 14002
    givePlayerCharacterSync(playerId, characterId)
    const policy = createRewardGrantItemOverflowPolicy(playerId)
    setInventoryFixtureItemExactSync(playerId, exBoostItemId, policy.maxCount(exBoostItemId))

    assert.throws(() => database.transaction(() => {
        rewardPlayerGachaDrawResultSync(
            playerId,
            { type: GachaType.CHARACTER },
            [characterId],
            undefined,
            [{ characterId, rarity: 4, movieId: "normal", seed: 3, requiresVerification: true }],
            {
                ownerGrant: plan => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                    playerId,
                    plan,
                    rewardGrantPlayerSnapshot(playerId),
                    { itemOverflow: policy },
                ),
            },
        )
        throw new Error("late gacha source failure")
    })(), /late gacha source failure/)
    assert.equal(getPlayerItemSync(playerId, exBoostItemId), policy.maxCount(exBoostItemId))
    assert.deepEqual(getPlayerMailsSync(playerId, 1, 100, true), [])
})

test("gacha source adapter writes capped overflow after external finalize", async () => {
    const { playerId } = await createPlayer("gacha-adapter-capped-overflow")
    const characterId = 1
    const exBoostItemId = 14002
    givePlayerCharacterSync(playerId, characterId)
    const policy = createRewardGrantItemOverflowPolicy(playerId)
    setInventoryFixtureItemExactSync(playerId, exBoostItemId, policy.maxCount(exBoostItemId))
    const player = getPlayerSync(playerId)
    const plan = createRewardGrantExecutionPlan([{ type: RewardType.CHARACTER, id: characterId }])

    const result = database.transaction(() => withDeferredInventoryBatchContextWithinTransactionSync({
        playerId,
        preloadItemIds: [exBoostItemId],
        playerExistence: "caller-verified",
    }, inventory => grantGachaRewardPlanInTransactionOwnerWithInventorySync(
        playerId,
        plan,
        {
            id: player.id,
            freeMana: player.freeMana,
            freeVmoney: player.freeVmoney,
            expPool: player.expPool,
        },
        inventory,
    )))()

    assert.equal(result.assets.items[0].acceptedAmount, 0)
    assert.equal(result.assets.items[0].overflowAmount, 1)
    assert.equal(getPlayerMailsSync(playerId, 1, 100, true).length, 1)
    assert.equal(getPlayerItemSync(playerId, exBoostItemId), policy.maxCount(exBoostItemId))

    assert.throws(() => database.transaction(() => {
        withDeferredInventoryBatchContextWithinTransactionSync({
            playerId,
            preloadItemIds: [exBoostItemId],
            playerExistence: "caller-verified",
        }, inventory => grantGachaRewardPlanInTransactionOwnerWithInventorySync(
            playerId,
            plan,
            {
                id: player.id,
                freeMana: player.freeMana,
                freeVmoney: player.freeVmoney,
                expPool: player.expPool,
            },
            inventory,
        ))
        throw new Error("late gacha adapter failure")
    })(), /late gacha adapter failure/)
    assert.equal(getPlayerMailsSync(playerId, 1, 100, true).length, 1)
    assert.equal(getPlayerItemSync(playerId, exBoostItemId), policy.maxCount(exBoostItemId))
})

test("character owner plan preserves per-draw movie order duplicate deltas and merged state", async () => {
    const { playerId } = await createPlayer("gacha-owner-character-plan")
    const existingCharacterId = 1
    const newCharacterId = 251001
    const specialMovieCharacterId = 111001
    const existingCompensationItemId = 14002
    const newCharacterCompensationItemId = 14017
    const drawResult = [
        existingCharacterId,
        newCharacterId,
        newCharacterId,
        specialMovieCharacterId,
        existingCharacterId,
        existingCharacterId,
        existingCharacterId,
        existingCharacterId,
        existingCharacterId,
        existingCharacterId,
    ]
    const moviePlan = drawResult.map((characterId, drawIndex) => ({
        characterId,
        rarity: drawIndex === 3 ? 5 : 4,
        movieId: drawIndex === 3 ? "rarity_5_guarantee" : `normal_${drawIndex}`,
        seed: 1000 + drawIndex,
        requiresVerification: drawIndex !== 3,
    }))
    setInventoryFixtureItemExactSync(playerId, existingCompensationItemId, 20)
    setInventoryFixtureItemExactSync(playerId, newCharacterCompensationItemId, 5)
    const knownPlayerBefore = rewardGrantPlayerSnapshot(playerId)
    let capturedPlan
    let deferredLog
    const quarantine = getDefaultGachaSeedQuarantine()
    const originalMarkSent = quarantine.markSent
    const markedSeeds = []
    quarantine.markSent = (...args) => markedSeeds.push(args)

    let measured
    try {
        database.transaction(() => {
            measured = captureSql(() => rewardPlayerGachaDrawResultSync(
                playerId,
                { type: GachaType.CHARACTER },
                drawResult,
                undefined,
                moviePlan,
                {
                    ownerGrant: plan => {
                        capturedPlan = plan
                        return executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                            playerId,
                            plan,
                            knownPlayerBefore,
                        )
                    },
                    deferCharacterSampledLog: log => { deferredLog = log },
                },
            ))
        })()
    } finally {
        quarantine.markSent = originalMarkSent
    }

    assert.ok(capturedPlan, "owner callback must receive the character reward plan")
    assert.deepEqual(capturedPlan.entries.map(entry => entry.id), drawResult)
    assert.equal(measured.result.draw.length, drawResult.length)
    assert.deepEqual(measured.result.draw[3], {
        character_id: specialMovieCharacterId,
        movie_id: "rarity_5_guarantee",
        seed: 1003,
        entry_count: 1,
    })
    assert.deepEqual(measured.result.draw[0].ex_boost_item, {
        id: existingCompensationItemId,
        count: 1,
    })
    assert.deepEqual(measured.result.draw[2].ex_boost_item, {
        id: newCharacterCompensationItemId,
        count: 1,
    })
    assert.equal(measured.result.items[existingCompensationItemId], 27)
    assert.equal(measured.result.items[newCharacterCompensationItemId], 6)
    assert.equal(
        measured.statements.filter(sql => /^\s*SELECT[\s\S]*\bFROM\s+players_items\b/i.test(sql)).length,
        2,
    )
    assert.equal(
        measured.statements.filter(sql => /^\s*INSERT\s+INTO\s+players_items\b/i.test(sql)).length,
        2,
    )
    assert.deepEqual(measured.result.characters.map(character => character.character_id), [
        existingCharacterId,
        newCharacterId,
        specialMovieCharacterId,
    ])
    assert.equal(measured.result.characters[0].stack, 7)
    assert.equal(measured.result.characters[1].stack, 1)
    assert.equal(typeof measured.result.characters[1].create_time, "string")
    assert.deepEqual(markedSeeds, moviePlan
        .filter(plan => plan.requiresVerification)
        .map(plan => [plan.movieId, plan.seed, plan.rarity]))
    assert.equal(typeof deferredLog, "function")
    assert.equal(JSON.stringify(measured.result).includes("itemDeltas"), false)
    assert.equal(JSON.stringify(measured.result).includes("joined_character_id_list"), false)
    assert.equal(JSON.stringify(measured.result).includes("isNew"), false)
    const playerReads = measured.statements.filter(sql => /^\s*SELECT[\s\S]*\bFROM\s+players\b/i.test(sql))
    assert.deepEqual(playerReads, [], playerReads.join("\n"))
    const transactionStatements = measured.statements.filter(sql => /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql))
    assert.deepEqual(transactionStatements, [], transactionStatements.join("\n"))
})

test("equipment owner plan preserves draw order metadata effects and last equipment state", async () => {
    const { playerId } = await createPlayer("gacha-owner-equipment-plan")
    const movieModule = require("../src/lib/gacha-equipment-movie")
    const originalCompute = movieModule.computeEquipmentGachaMovieEffectsForGacha
    const drawResult = [4030003, 4030003, 5020008]
    const metadata = [
        { id: drawResult[0], rank: 4, isGuarantee: false },
        { id: drawResult[1], rank: 4, isGuarantee: false },
        { id: drawResult[2], rank: 5, isGuarantee: false },
    ]
    let movieInputs
    let capturedPlan
    movieModule.computeEquipmentGachaMovieEffectsForGacha = (_gacha, inputs) => {
        movieInputs = inputs
        return {
            isErupt: false,
            draws: [
                { equipmentId: drawResult[0], treasureUpType: 3 },
                { equipmentId: drawResult[1], treasureUpType: 0 },
                { equipmentId: drawResult[2], treasureUpType: 1 },
            ],
        }
    }

    let result
    try {
        const knownPlayerBefore = rewardGrantPlayerSnapshot(playerId)
        result = database.transaction(() => rewardPlayerGachaDrawResultSync(
            playerId,
            { type: GachaType.WEAPON },
            drawResult,
            metadata,
            undefined,
            {
                ownerGrant: plan => {
                    capturedPlan = plan
                    return executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                        playerId,
                        plan,
                        knownPlayerBefore,
                    )
                },
            },
        ))()
    } finally {
        movieModule.computeEquipmentGachaMovieEffectsForGacha = originalCompute
    }

    assert.deepEqual(movieInputs, metadata.map(({ id, rank, isGuarantee }) => ({ id, rank, isGuarantee })))
    assert.ok(capturedPlan, "owner callback must receive the equipment reward plan")
    assert.deepEqual(capturedPlan.entries.map(entry => entry.id), drawResult)
    assert.deepEqual(result.draw, [
        { equipment_id: drawResult[0], treasure_up_type: 3 },
        { equipment_id: drawResult[1], treasure_up_type: 0 },
        { equipment_id: drawResult[2], treasure_up_type: 1 },
    ])
    assert.equal(result.isErupt, false)
    assert.deepEqual(result.equipment.map(item => [item.equipment_id, item.stack]), [
        [drawResult[0], 1],
        [drawResult[2], 0],
    ])
})

test("owner path rejects metadata and returned typed reward mismatches with no committed rewards", async () => {
    const movieMismatchPlayer = await createPlayer("gacha-owner-movie-mismatch")
    let movieMismatchOwnerCalls = 0
    assert.throws(
        database.transaction(() => rewardPlayerGachaDrawResultSync(
            movieMismatchPlayer.playerId,
            { type: GachaType.CHARACTER },
            [251001, 251002],
            undefined,
            [{ characterId: 251001, rarity: 4, movieId: "normal", seed: 1001, requiresVerification: true }],
            {
                ownerGrant: () => {
                    movieMismatchOwnerCalls++
                    throw new Error("owner must not run")
                },
            },
        )),
        /movie plan.*draw result/i,
    )
    assert.equal(movieMismatchOwnerCalls, 0)
    assert.equal(getPlayerCharacterSync(movieMismatchPlayer.playerId, 251001), null)

    const metadataMismatchPlayer = await createPlayer("gacha-owner-metadata-mismatch")
    assert.throws(
        database.transaction(() => rewardPlayerGachaDrawResultSync(
            metadataMismatchPlayer.playerId,
            { type: GachaType.WEAPON },
            [5040016, 5020008],
            [{ id: 5040016, rank: 4, isGuarantee: false }],
            undefined,
            {
                ownerGrant: plan => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                    metadataMismatchPlayer.playerId,
                    plan,
                    rewardGrantPlayerSnapshot(metadataMismatchPlayer.playerId),
                ),
            },
        )),
        /metadata.*draw result/i,
    )
    assert.deepEqual(getPlayerEquipmentListSync(metadataMismatchPlayer.playerId), {})

    const resultMismatchPlayer = await createPlayer("gacha-owner-result-mismatch")
    assert.throws(
        database.transaction(() => rewardPlayerGachaDrawResultSync(
            resultMismatchPlayer.playerId,
            { type: GachaType.WEAPON },
            [5040016, 5020008],
            [
                { id: 5040016, rank: 4, isGuarantee: false },
                { id: 5020008, rank: 3, isGuarantee: false },
            ],
            undefined,
            {
                ownerGrant: plan => {
                    const granted = executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                        resultMismatchPlayer.playerId,
                        plan,
                        rewardGrantPlayerSnapshot(resultMismatchPlayer.playerId),
                    )
                    return {
                        ...granted,
                        entries: granted.entries.map((entry, index) => index === 0
                            ? { ...entry, reward: { ...entry.reward, id: 999999999 } }
                            : entry),
                    }
                },
            },
        )),
        /Invalid RewardGrant contract at entry 0: reward/,
    )
    assert.deepEqual(getPlayerEquipmentListSync(resultMismatchPlayer.playerId), {})
})

test("owner path rolls a valid earlier draw back when a later character is unknown", async () => {
    const { playerId } = await createPlayer("gacha-owner-unknown-character")
    const knownPlayerBefore = rewardGrantPlayerSnapshot(playerId)

    assert.throws(
        database.transaction(() => rewardPlayerGachaDrawResultSync(
            playerId,
            { type: GachaType.CHARACTER },
            [251001, 999999996],
            undefined,
            [
                { characterId: 251001, rarity: 4, movieId: "normal", seed: 1001, requiresVerification: true },
                { characterId: 999999996, rarity: 4, movieId: "normal", seed: 1002, requiresVerification: true },
            ],
            {
                ownerGrant: plan => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                    playerId,
                    plan,
                    knownPlayerBefore,
                ),
                deferCharacterSampledLog: () => assert.fail("failed grants must not schedule a success log"),
            },
        )),
        /RewardGrant entry 1 failed: unknown Character 999999996/,
    )
    assert.equal(getPlayerCharacterSync(playerId, 251001), null)
})
