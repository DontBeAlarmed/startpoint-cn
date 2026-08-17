"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
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
const { getPlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { givePlayerCharactersExpSync } = require("../src/lib/character")
const { givePlayerScoreRewardsSync } = require("../src/lib/quest")
const { RewardType, ScoreRewardType } = require("../src/lib/types/rewards")
const {
    AWAKE_CHARACTER_ID,
    makeAwakeEligible,
} = require("./perf/single_battle_settlement_fixture.cjs")

let database

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
    database = data.initializeDatabase()
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
        advanceSingleSettlementRewardPlayerState,
        grantSingleSettlementRewardsWithinTransactionSync,
        withSingleSettlementExpPool,
    } = loadAdapter()
    const playerId = createPlayer("real-state-chain")
    makeAwakeEligible(playerId)
    const before = getPlayerSync(playerId)
    let scoreResult
    let characterExpResult
    let directResult

    database.transaction(() => {
        let state = {
            freeMana: before.freeMana,
            freeVmoney: before.freeVmoney,
            expPool: before.expPool,
        }
        scoreResult = givePlayerScoreRewardsSync(
            playerId, 990023, manaScoreReward(17), false,
        )
        state = advanceSingleSettlementRewardPlayerState(state, scoreResult.user_info)
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
        advanceSingleSettlementRewardPlayerState,
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
        const scoreResult = givePlayerScoreRewardsSync(
            playerId, 990024, manaScoreReward(19), false,
        )
        state = advanceSingleSettlementRewardPlayerState(state, scoreResult.user_info)
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

test("single settlement migrates only the five direct standard reward paths", () => {
    const adapter = readSource("src/lib/quest/finish/single-settlement-reward-grant.ts")
    const writes = readSource("src/lib/quest/finish/single-settlement-writes.ts")

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
    assert.match(writes, /let rewardPlayerState = \{\s*freeMana: settlementPlayer\.freeMana,\s*freeVmoney: settlementPlayer\.freeVmoney,\s*expPool: settlementPlayer\.expPool,?\s*\}/)
    assert.match(writes, /rewardPlayerState = result\.playerAfter/)
    assert.match(writes, /rewardPlayerState = \{\s*freeMana: newMana,\s*freeVmoney: rewardPlayerState\.freeVmoney,\s*expPool: settlementPlayer\.expPool \+ fixedPoolExpReward,?\s*\}/)
    assert.match(writes, /advanceSingleSettlementRewardPlayerState\(\s*rewardPlayerState, scoreRewardsResult\.user_info,?\s*\)/)
    assert.match(writes, /withSingleSettlementExpPool\(\s*rewardPlayerState, rewardCharacterExpResult\.exp_pool,?\s*\)/)

    assert.match(writes, /\bgivePlayerScoreRewardsSync\s*\(/)
    assert.match(writes, /\bgrantCarnivalRewards\s*\(/)
    assert.match(writes, /\bsettleMissionCategories\s*\(/)
    assert.match(writes, /\bsettleAwakeBattleMissions\s*\(/)
})
