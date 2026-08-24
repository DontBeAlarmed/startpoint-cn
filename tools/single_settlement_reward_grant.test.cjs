"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const BetterSqlite3 = require("better-sqlite3")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const adapterPath = path.join(
    projectRoot,
    "src/lib/quest/finish/single-settlement-reward-grant.ts",
)
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "single-settlement-reward-grant-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerItemSync, givePlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { givePlayerCharacterSync, givePlayerCharactersExpSync } = require("../src/lib/character")
const { getScoreRewardGroup } = require("../src/lib/assets")
const { givePlayerScoreRewardsSync } = require("../src/lib/quest")
const { selectScoreRewardGrantPlan } = require("../src/lib/quest/score-reward-selection")
const { RewardType, ScoreRewardType } = require("../src/lib/types/rewards")
const {
    AWAKE_CHARACTER_ID,
    makeAwakeEligible,
} = require("./perf/single_battle_settlement_fixture.cjs")

let database
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

function sequence(values) {
    let index = 0
    return () => {
        assert.ok(index < values.length, "random sequence exhausted")
        return values[index++]
    }
}

function scoreOptions(values) {
    return {
        commonRewardCount: 0,
        random: sequence(values),
        rewardCampaignRates: { item: 1, exp: 1, mana: 1 },
        rewardDate: new Date("2024-08-14T12:00:00.000Z"),
    }
}

function stableProtocolResult(result) {
    return JSON.parse(JSON.stringify(result, (key, value) => (
        key === "create_time" || key === "update_time" || key === "join_time"
            ? "<time>"
            : value
    )))
}

function readSource(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
}

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function loadAdapter() {
    assert.ok(fs.existsSync(adapterPath), "single settlement reward grant adapter must exist")
    return require(adapterPath)
}

test.before(() => {
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath, {
            verbose: sql => { if (sqlTrace.active) sqlTrace.statements.push(sql) },
        }),
    })
})

test.after(() => {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("adapter preserves the finite settlement source kind and original reward index", () => {
    const { grantSingleSettlementRewardsWithinTransactionSync } = loadAdapter()
    const sourceKinds = ["clear", "s_plus", "additional", "rush", "score_attack"]

    for (const sourceKind of sourceKinds) {
        const playerId = createPlayer(sourceKind)
        const itemId = 920000 + sourceKinds.indexOf(sourceKind)
        const player = getPlayerSync(playerId)
        const result = database.transaction(() =>
            grantSingleSettlementRewardsWithinTransactionSync(playerId, sourceKind, [
                { type: RewardType.ITEM, id: itemId, count: 2 },
                { type: RewardType.MANA, count: 3 },
            ], {
                freeMana: player.freeMana,
                freeVmoney: player.freeVmoney,
                expPool: player.expPool,
            }))()

        assert.deepEqual(result.entries.map(entry => entry.source), [
            { kind: sourceKind, index: 0 },
            { kind: sourceKind, index: 1 },
        ])
        assert.deepEqual(result.aggregate.user_info, {
            free_mana: 3,
            free_vmoney: 0,
            exp_pool: 0,
        })
        assert.equal(result.aggregate.items[itemId], 2)
        assert.equal(getPlayerItemSync(playerId, itemId), 2)
        assert.equal(result.playerAfter.freeMana, 2003)
    }
})

test("adapter requires the caller transaction supplied by single finish", () => {
    const { grantSingleSettlementRewardsWithinTransactionSync } = loadAdapter()
    const playerId = createPlayer("caller-transaction")
    const player = getPlayerSync(playerId)

    assert.throws(
        () => grantSingleSettlementRewardsWithinTransactionSync(playerId, "clear", [], {
            freeMana: player.freeMana,
            freeVmoney: player.freeVmoney,
            expPool: player.expPool,
        }),
        error => error?.name === "RewardGrantTransactionRequiredError",
    )
})

test("real equipment Score group 2924 preserves every compatibility response entry", () => {
    const { grantSingleSettlementScoreRewardsWithinTransactionSync } = loadAdapter()
    const scoreRewards = getScoreRewardGroup(2924)
    assert.notEqual(scoreRewards, null)
    const compatibilityPlayerId = createPlayer("score-2924-compatibility")
    const singlePlayerId = createPlayer("score-2924-single")
    const compatibility = database.transaction(() => givePlayerScoreRewardsSync(
        compatibilityPlayerId,
        2924,
        scoreRewards,
        false,
        0,
        scoreOptions([0, 0, 0, 0, 0, 0, 0, 0]),
    ))()
    const playerBefore = getPlayerSync(singlePlayerId)
    const selection = selectScoreRewardGrantPlan(
        2924,
        scoreRewards,
        false,
        0,
        scoreOptions([0, 0, 0, 0, 0, 0, 0, 0]),
    )
    const single = database.transaction(() => (
        grantSingleSettlementScoreRewardsWithinTransactionSync(
            singlePlayerId,
            selection,
            {
                freeMana: playerBefore.freeMana,
                freeVmoney: playerBefore.freeVmoney,
                expPool: playerBefore.expPool,
            },
        )
    ))().result

    assert.deepEqual(single, compatibility)
    assert.deepEqual(single.equipment_list.map(entry => entry.equipment_id), [
        5010026,
        5050018,
        5050018,
    ])
})

test("real character Score group 3001 matches compatibility response without extra character SQL", () => {
    const { grantSingleSettlementScoreRewardsWithinTransactionSync } = loadAdapter()
    const scoreRewards = getScoreRewardGroup(3001)
    assert.notEqual(scoreRewards, null)
    const compatibilityPlayerId = createPlayer("score-3001-compatibility")
    const singlePlayerId = createPlayer("score-3001-single")
    const compatibilityMeasured = captureSql(() => database.transaction(() => (
        givePlayerScoreRewardsSync(
            compatibilityPlayerId,
            3001,
            scoreRewards,
            false,
            0,
            scoreOptions([0, 0]),
        )
    ))())
    const playerBefore = getPlayerSync(singlePlayerId)
    const singleMeasured = captureSql(() => {
        const selection = selectScoreRewardGrantPlan(
            3001,
            scoreRewards,
            false,
            0,
            scoreOptions([0, 0]),
        )
        return database.transaction(() => (
            grantSingleSettlementScoreRewardsWithinTransactionSync(
                singlePlayerId,
                selection,
                {
                    freeMana: playerBefore.freeMana,
                    freeVmoney: playerBefore.freeVmoney,
                    expPool: playerBefore.expPool,
                },
            )
        ))().result
    })
    const characterReadCount = statements => statements.filter(sql => (
        /^\s*SELECT/i.test(sql) && /\bFROM\s+players_characters\b/i.test(sql)
    )).length

    assert.deepEqual(
        stableProtocolResult(singleMeasured.result),
        stableProtocolResult(compatibilityMeasured.result),
    )
    assert.deepEqual(singleMeasured.result.joined_character_id_list, [])
    assert.equal(characterReadCount(singleMeasured.statements), characterReadCount(compatibilityMeasured.statements))
    assert.equal(characterReadCount(singleMeasured.statements), 1)
})

test("real duplicate character Score group projects compensation delta while DB keeps final inventory", () => {
    const { grantSingleSettlementScoreRewardsWithinTransactionSync } = loadAdapter()
    const scoreRewards = getScoreRewardGroup(200009)
    assert.notEqual(scoreRewards, null)

    const prepareDuplicate = label => {
        const playerId = createPlayer(label)
        const character = givePlayerCharacterSync(playerId, 341003)
        assert.equal(character?.isNew, true)
        assert.equal(givePlayerItemSync(playerId, 14010, 1), 1)
        return playerId
    }
    const compatibilityPlayerId = prepareDuplicate("score-200009-compatibility")
    const singlePlayerId = prepareDuplicate("score-200009-single")
    const randomValues = [0.9, 0.9, 0, 0]
    const compatibility = database.transaction(() => givePlayerScoreRewardsSync(
        compatibilityPlayerId,
        200009,
        scoreRewards,
        false,
        0,
        scoreOptions(randomValues),
    ))()
    const playerBefore = getPlayerSync(singlePlayerId)
    const selection = selectScoreRewardGrantPlan(
        200009,
        scoreRewards,
        false,
        0,
        scoreOptions(randomValues),
    )
    const singleGrant = database.transaction(() => (
        grantSingleSettlementScoreRewardsWithinTransactionSync(
            singlePlayerId,
            selection,
            {
                freeMana: playerBefore.freeMana,
                freeVmoney: playerBefore.freeVmoney,
                expPool: playerBefore.expPool,
            },
        )
    ))()

    assert.deepEqual(singleGrant.result, compatibility)
    assert.deepEqual(singleGrant.result.items, { 14010: 1 })
    assert.equal(Object.hasOwn(singleGrant.grant.entries[0], "itemDeltas"), false)
    assert.equal(getPlayerItemSync(compatibilityPlayerId, 14010), 2)
    assert.equal(getPlayerItemSync(singlePlayerId, 14010), 2)
})

function manaScoreReward(count) {
    return [{
        position: 1,
        type: ScoreRewardType.ITEM,
        reward_type: RewardType.MANA,
        count,
        field5: 1,
    }]
}

test("real settlement state chain carries score currency and character overflow into later direct rewards", () => {
    const {
        grantSingleSettlementScoreRewardsWithinTransactionSync,
        grantSingleSettlementRewardsWithinTransactionSync,
        withSingleSettlementExpPool,
    } = loadAdapter()
    const playerId = createPlayer("real-state-chain")
    makeAwakeEligible(playerId)
    const before = getPlayerSync(playerId)
    let scoreResult
    let scoreGrantResult
    let characterExpResult
    let directResult

    database.transaction(() => {
        let state = {
            freeMana: before.freeMana,
            freeVmoney: before.freeVmoney,
            expPool: before.expPool,
        }
        const scoreSelection = selectScoreRewardGrantPlan(
            990023, manaScoreReward(17), false,
        )
        const scoreGrant = grantSingleSettlementScoreRewardsWithinTransactionSync(
            playerId, scoreSelection, state,
        )
        scoreGrantResult = scoreGrant.grant
        scoreResult = scoreGrant.result
        state = scoreGrant.grant.playerAfter
        characterExpResult = givePlayerCharactersExpSync(
            playerId, [AWAKE_CHARACTER_ID], 13, false,
        )
        state = withSingleSettlementExpPool(state, characterExpResult.exp_pool)
        directResult = grantSingleSettlementRewardsWithinTransactionSync(
            playerId,
            "additional",
            [
                { type: RewardType.BEADS, count: 5 },
                { type: RewardType.EXP, count: 7 },
            ],
            state,
        )
    })()

    assert.deepEqual(scoreResult.user_info, {
        free_mana: 17,
        free_vmoney: 0,
        exp_pool: 0,
    })
    assert.deepEqual(scoreResult.drop_score_reward_ids, [
        { group_id: 990023, index: 1, number: 17 },
    ])
    assert.deepEqual(scoreResult.drop_rare_reward_ids, [])
    assert.deepEqual(scoreGrantResult.entries.map(entry => ({
        source: entry.source,
        reward: entry.reward,
        userInfo: entry.result.user_info,
    })), [{
        source: { kind: "score_common", groupId: 990023, index: 1, number: 17 },
        reward: { type: RewardType.MANA, count: 17 },
        userInfo: { free_mana: 17, free_vmoney: 0, exp_pool: 0 },
    }])
    assert.deepEqual(scoreGrantResult.aggregate, {
        user_info: scoreResult.user_info,
        character_list: scoreResult.character_list,
        joined_character_id_list: scoreResult.joined_character_id_list,
        equipment_list: scoreResult.equipment_list,
        items: scoreResult.items,
    })
    assert.equal(characterExpResult.add_exp_list[0].add_exp_pool, 13)
    assert.deepEqual(directResult.aggregate.user_info, {
        free_mana: 0,
        free_vmoney: 5,
        exp_pool: 7,
    })
    assert.deepEqual(directResult.playerAfter, {
        freeMana: before.freeMana + 17,
        freeVmoney: before.freeVmoney + 5,
        expPool: before.expPool + 13 + 7,
    })
    const after = getPlayerSync(playerId)
    assert.deepEqual({
        freeMana: after.freeMana,
        freeVmoney: after.freeVmoney,
        expPool: after.expPool,
    }, directResult.playerAfter)
})

test("a later owner reward failure rolls the real settlement state chain back", () => {
    const {
        grantSingleSettlementScoreRewardsWithinTransactionSync,
        grantSingleSettlementRewardsWithinTransactionSync,
        withSingleSettlementExpPool,
    } = loadAdapter()
    const playerId = createPlayer("real-state-chain-rollback")
    makeAwakeEligible(playerId)
    const itemId = 920023
    const before = getPlayerSync(playerId)

    assert.throws(database.transaction(() => {
        let state = {
            freeMana: before.freeMana,
            freeVmoney: before.freeVmoney,
            expPool: before.expPool,
        }
        const scoreSelection = selectScoreRewardGrantPlan(
            990024, manaScoreReward(19), false,
        )
        const scoreGrant = grantSingleSettlementScoreRewardsWithinTransactionSync(
            playerId, scoreSelection, state,
        )
        state = scoreGrant.grant.playerAfter
        const characterExpResult = givePlayerCharactersExpSync(
            playerId, [AWAKE_CHARACTER_ID], 11, false,
        )
        state = withSingleSettlementExpPool(state, characterExpResult.exp_pool)
        grantSingleSettlementRewardsWithinTransactionSync(
            playerId,
            "rush",
            [
                { type: RewardType.ITEM, id: itemId, count: 1 },
                { type: RewardType.BEADS, count: 3 },
                { type: RewardType.CHARACTER, id: 999999996 },
            ],
            state,
        )
    }), error => error?.name === "RewardGrantExecutionError")

    const after = getPlayerSync(playerId)
    assert.deepEqual({
        freeMana: after.freeMana,
        freeVmoney: after.freeVmoney,
        expPool: after.expPool,
    }, {
        freeMana: before.freeMana,
        freeVmoney: before.freeVmoney,
        expPool: before.expPool,
    })
    assert.equal(getPlayerItemSync(playerId, itemId), null)
})

test("single settlement migrates score while preserving multiplayer, Carnival and Mission boundaries", () => {
    const adapter = readSource("src/lib/quest/finish/single-settlement-reward-grant.ts")
    const writes = readSource("src/lib/quest/finish/single-settlement-writes.ts")
    const missionPublication = readSource("src/lib/quest/finish/single-mission-publication.ts")
    const responseState = readSource("src/lib/quest/finish/single-settlement-response-state.ts")

    assert.match(adapter, /createRewardGrantPlan\s*\(/)
    assert.match(adapter, /executeRewardGrantPlanInTransactionOwnerSync\s*\(/)
    assert.doesNotMatch(adapter, /executeRewardGrantPlanWithinTransactionSync\s*\(/)
    assert.doesNotMatch(adapter, /executeRewardGrantPlanSync\s*\(/)
    assert.doesNotMatch(adapter, /\.transaction\s*\(/)
    assert.doesNotMatch(adapter, /\bany\b/)

    assert.doesNotMatch(writes, /\bgivePlayerRewardsSync\b/)
    assert.doesNotMatch(writes, /\bgivePlayerRewardSync\b/)
    for (const kind of ["clear", "s_plus", "additional", "rush", "score_attack"]) {
        assert.match(writes, new RegExp(`grantDirectRewards\\([^\\n]*"${kind}"`), kind)
    }
    assert.match(responseState, /let playerState:\s*RewardGrantPlayerAfter\s*=\s*\{\s*freeMana:\s*player\.freeMana,\s*freeVmoney:\s*player\.freeVmoney,\s*expPool:\s*player\.expPool,?\s*\}/)
    assert.match(responseState, /playerState = grant\.playerAfter/)
    assert.match(responseState, /observeItems\(grant\.aggregate\.items\)/)
    assert.match(writes, /responseState\.setPlayerState\(\{\s*freeMana:\s*newMana,\s*freeVmoney:\s*responseState\.playerState\.freeVmoney,\s*expPool:\s*settlementPlayer\.expPool \+ fixedPoolExpReward,?\s*\}\)/)
    assert.match(writes, /selectScoreRewardGrantPlan\s*\(/)
    assert.match(writes, /grantSingleSettlementScoreRewardsWithinTransactionSync\s*\(/)
    assert.match(writes, /responseState\.observeGrant\(scoreRewardGrant\.grant\)/)
    assert.match(writes, /responseState\.setExpPool\(rewardCharacterExpResult\.exp_pool\)/)

    assert.doesNotMatch(writes, /\bgivePlayerScoreRewardsSync\s*\(/)
    assert.match(writes, /\bgrantCarnivalRewards\s*\(/)
    assert.match(writes, /\bsettleSingleMissionEvaluations\s*\(/)
    assert.match(missionPublication, /\bsettleMissionCategoriesWithEvaluation\s*\(/)
    assert.match(missionPublication, /\bsettleAwakeMissionCandidatesWithEvaluation\s*\(/)
    assert.match(missionPublication, /input\.rewardDependencies/)
    assert.match(writes, /standardRewardGrant: standardRewardGrant\.forMission/)

    const multiplayer = readSource("src/multi/settlement/orchestrator.ts")
    assert.match(multiplayer, /import \{[^}]*givePlayerScoreRewardsSync[^}]*\} from "\.\.\/\.\.\/lib\/quest"/s)
    assert.match(multiplayer, /\bgivePlayerScoreRewardsSync\s*\(/)
    assert.doesNotMatch(multiplayer, /grantSingleSettlementScoreRewardsWithinTransactionSync/)
})
