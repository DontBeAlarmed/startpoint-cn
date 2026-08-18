"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { getPlayerSync, updatePlayerSync } = require("../../src/data/domains/player")
const { getPlayerActiveQuestSync } = require("../../src/data/domains/quest_active")
const { getPlayerSingleQuestProgressSync } = require("../../src/data/domains/quest")
const { activeQuests } = require("../../src/lib/quest/active-quest-service")
const { getStaminaCost } = require("../../src/lib/stamina-cost")
const {
    postCnRequest,
    requireSuccessfulCnResponse,
} = require("./non_multi_mixed_http.cjs")

const CATEGORY = 1
const QUEST_ID = 1001002
const CHARACTER_ID = 1
const PARTY_ID = 2
const PLAY_ID = "non-multi-mixed-single-battle"
const START_STAMINA = 100

function prepareSingleBattleIdentity(db, identity) {
    assert.ok(identity?.playerId > 0, "single battle identity must have a player")
    assert.deepEqual(
        db.prepare(`
            SELECT id FROM players_characters
            WHERE player_id = ? AND id = ?
        `).get(identity.playerId, CHARACTER_ID),
        { id: CHARACTER_ID },
    )
    assert.equal(
        db.prepare(`
            SELECT character_id_1 FROM players_parties
            WHERE player_id = ? AND slot = ? AND group_id = 1 AND category = ?
        `).get(identity.playerId, PARTY_ID, CATEGORY)?.character_id_1,
        CHARACTER_ID,
    )
    updatePlayerSync({
        id: identity.playerId,
        stamina: START_STAMINA,
        staminaHealTime: new Date(Date.now() - 60_000),
    })
}

function createActiveQuestSentinel() {
    return {
        questId: QUEST_ID,
        category: CATEGORY,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        coordinatorOrigin: null,
        playId: "non-multi-mixed-active-sentinel",
        continueCount: 0,
    }
}

function startPayload(identity) {
    return {
        viewer_id: identity.viewerId,
        api_count: 1,
        quest_id: QUEST_ID,
        category: CATEGORY,
        party_id: PARTY_ID,
        play_id: PLAY_ID,
        use_boost_point: false,
        use_boss_boost_point: false,
        is_auto_start_mode: false,
    }
}

function finishPayload(identity, {
    playId = PLAY_ID,
    questId = QUEST_ID,
    category = CATEGORY,
} = {}) {
    return {
        viewer_id: identity.viewerId,
        api_count: 1,
        play_id: playId,
        quest_id: questId,
        category,
        score: 123_456,
        elapsed_time_ms: 1_000,
        add_mana: 11,
        is_accomplished: true,
        is_restored: false,
        continue_count: 0,
        statistics: {
            clear_phase: 1,
            max_combo_count: 30,
            zones: [{
                use_power_flip_count: 5,
                use_dash_count: 5,
                use_skill_count: 5,
                damage_deal_total: 1_000,
                members: [{ origin_damage: 1_000 }, null, null],
            }],
            party: {
                characters: [{ id: CHARACTER_ID }, null, null],
                unison_characters: [null, null, null],
                equipments: [null, null, null],
                ability_soul_ids: [null, null, null],
            },
        },
    }
}

function requireSuccessful(response, label, identity) {
    const payload = requireSuccessfulCnResponse(response, label)
    assert.equal(payload.data_headers?.viewer_id, identity.viewerId, `${label} viewer`)
    assert.equal(payload.data?.is_multi, "single", `${label} mode`)
    return payload
}

function stableActiveQuest(playerId) {
    const quest = getPlayerActiveQuestSync(playerId)
    if (!quest) return null
    return stableQuestFields(quest)
}

function stableQuestFields(quest) {
    return {
        playId: quest.playId,
        questId: quest.questId,
        category: quest.category,
        isMulti: quest.isMulti,
        continueCount: quest.continueCount,
    }
}

function requireNonNegativeInteger(value, label) {
    assert.ok(Number.isSafeInteger(value) && value >= 0, `${label} must be non-negative integer`)
    return value
}

function snapshotBattleLifecycleState(playerId) {
    const player = getPlayerSync(playerId)
    return {
        databaseActive: getPlayerActiveQuestSync(playerId),
        memoryActive: activeQuests[playerId] === undefined
            ? undefined
            : structuredClone(activeQuests[playerId]),
        stamina: player?.stamina,
    }
}

function snapshotSingleBattleState(context, playerId) {
    if (typeof context.snapshotSingleBattleState === "function") {
        return structuredClone(context.snapshotSingleBattleState())
    }
    return snapshotBattleLifecycleState(playerId)
}

function assertSingleBattleStateUnchanged(context, playerId, before, label) {
    assert.deepEqual(
        snapshotSingleBattleState(context, playerId),
        before,
        `${label} changed A owner state`,
    )
}

function requireRejected(response, label) {
    const accepted = response.statusCode === 400
        && response.payload !== null
        && typeof response.payload === "object"
        && !Array.isArray(response.payload)
        && response.payload.error === "Bad Request"
    assert.equal(accepted, true, `${label} must be rejected with HTTP 400 Bad Request`)
    return true
}

async function executeSingleBattleScenario(app, identity, context = {}) {
    if (!context.skipPrepare && typeof context.prepareSingleBattleIdentity === "function") {
        context.prepareSingleBattleIdentity(identity)
    }
    const beforePlayer = getPlayerSync(identity.playerId)
    assert.ok(beforePlayer, "single battle player must exist")
    const cost = getStaminaCost(`${CATEGORY}_${QUEST_ID}`).cost
    const started = requireSuccessful(
        await postCnRequest(app, "/api/index.php/single_battle_quest/start", startPayload(identity)),
        "single battle start",
        identity,
    )
    const afterStartPlayer = getPlayerSync(identity.playerId)
    assert.equal(started.data?.user_info?.stamina, afterStartPlayer.stamina)
    assert.equal(started.data?.category_id, CATEGORY)
    assert.equal(started.data?.is_multi, "single")
    const afterStartQuest = stableActiveQuest(identity.playerId)
    assert.deepEqual(afterStartQuest, {
        playId: PLAY_ID,
        questId: QUEST_ID,
        category: CATEGORY,
        isMulti: false,
        continueCount: 0,
    })
    assert.deepEqual(stableQuestFields(activeQuests[identity.playerId]), afterStartQuest)
    assert.equal(afterStartPlayer.stamina, beforePlayer.stamina - cost)

    const peer = context.singleBattlePeer
    assert.ok(peer?.viewerId > 0 && peer.viewerId !== identity.viewerId, "single battle peer is required")
    const peerFinishBefore = snapshotSingleBattleState(context, identity.playerId)
    const crossOwnerFinishRejected = requireRejected(
        await postCnRequest(
            app,
            "/api/index.php/single_battle_quest/finish",
            finishPayload(peer),
        ),
        "cross-owner finish",
    )
    assertSingleBattleStateUnchanged(context, identity.playerId, peerFinishBefore, "cross-owner finish")

    const wrongPlayBefore = snapshotSingleBattleState(context, identity.playerId)
    const wrongPlayIdFinishRejected = requireRejected(
        await postCnRequest(
            app,
            "/api/index.php/single_battle_quest/finish",
            finishPayload(identity, { playId: `${PLAY_ID}-wrong` }),
        ),
        "wrong play_id finish",
    )
    assertSingleBattleStateUnchanged(context, identity.playerId, wrongPlayBefore, "wrong play_id finish")

    const duplicateStartBefore = snapshotSingleBattleState(context, identity.playerId)
    const duplicateStartRejected = requireRejected(
        await postCnRequest(
            app,
            "/api/index.php/single_battle_quest/start",
            startPayload(identity),
        ),
        "duplicate start",
    )
    assertSingleBattleStateUnchanged(context, identity.playerId, duplicateStartBefore, "duplicate start")

    const beforeFinishStamina = afterStartPlayer.stamina
    const beforeProgress = getPlayerSingleQuestProgressSync(identity.playerId, CATEGORY, QUEST_ID)
    const finished = requireSuccessful(
        await postCnRequest(app, "/api/index.php/single_battle_quest/finish", finishPayload(identity)),
        "single battle finish",
        identity,
    )
    const afterFinishPlayer = getPlayerSync(identity.playerId)
    const afterProgress = getPlayerSingleQuestProgressSync(identity.playerId, CATEGORY, QUEST_ID)
    const rewards = finished.data.rewards
    const reward = {
        rewardMana: requireNonNegativeInteger(rewards.reward_mana, "reward mana"),
        fieldMana: requireNonNegativeInteger(rewards.field_mana, "field mana"),
        rewardPoolExp: requireNonNegativeInteger(rewards.reward_pool_exp, "reward pool exp"),
    }
    assert.equal(stableActiveQuest(identity.playerId), null)
    assert.equal(activeQuests[identity.playerId], undefined)
    assert.equal(afterFinishPlayer.stamina, beforeFinishStamina)
    assert.equal(afterProgress?.finished, true)

    const repeatedFinishBefore = snapshotSingleBattleState(context, identity.playerId)
    const repeated = await postCnRequest(
        app,
        "/api/index.php/single_battle_quest/finish",
        finishPayload(identity),
    )
    const repeatedFinishRejected = requireRejected(repeated, "repeated finish")
    const repeatedFinishAfter = snapshotSingleBattleState(context, identity.playerId)
    assert.deepEqual(repeatedFinishAfter, repeatedFinishBefore, "repeated finish changed A owner state")

    return {
        entry: "single-battle",
        adapter: "fastify-route:/api/index.php/single_battle_quest/start->finish",
        statusCode: 200,
        resultCode: 1,
        viewerId: identity.viewerId,
        category: CATEGORY,
        questId: QUEST_ID,
        playId: PLAY_ID,
        isMulti: "single",
        start: {
            activeQuest: afterStartQuest,
            stamina: {
                before: beforePlayer.stamina,
                after: afterStartPlayer.stamina,
                spent: cost,
            },
        },
        finish: {
            activeQuest: null,
            stamina: {
                before: beforeFinishStamina,
                after: afterFinishPlayer.stamina,
                delta: afterFinishPlayer.stamina - beforeFinishStamina,
            },
            reward,
            missionProgressChanged: beforeProgress?.finished !== afterProgress?.finished,
        },
        repeatedFinishRejected,
        negativeLifecycle: {
            crossOwnerFinishRejected,
            wrongPlayIdFinishRejected,
            duplicateStartRejected,
        },
        multiRecoveryInspections: typeof context.getMultiRecoveryInspections === "function"
            ? context.getMultiRecoveryInspections()
            : 0,
    }
}

module.exports = {
    CATEGORY,
    CHARACTER_ID,
    PLAY_ID,
    QUEST_ID,
    createActiveQuestSentinel,
    executeSingleBattleScenario,
    finishPayload,
    prepareSingleBattleIdentity,
    requireRejected,
    startPayload,
}
