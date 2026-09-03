"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-overflow-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()
const { closeDatabase, initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCharactersSync } = require("../src/data/domains/character")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { getPlayerMailsSync, MailType } = require("../src/data/domains/mail")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getPlayerActiveQuestSync } = require("../src/data/domains/quest_active")
const { getQuestFromCategorySync } = require("../src/lib/assets")
const {
    activeQuests,
    insertActiveQuest,
} = require("../src/lib/quest/active-quest-service")
const {
    calculateFixedQuestMana,
    getRewardCampaignRates,
} = require("../src/lib/reward-campaign")
const { QuestCategory, RewardType } = require("../src/lib/types")
const {
    projectMultiplayerFinishResponse,
} = require("../src/multi/settlement/response")
const {
    runMultiplayerSettlementOrchestration,
} = require("../src/multi/settlement/orchestrator")
const { setInventoryFixtureItemExactSync } = require("./helpers/inventory-fixture.cjs")
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const FIXED_TIME = Date.parse("2024-08-14T12:00:00.000Z")
const QUEST_ID = 2001
const ITEM_ID = 99
const ITEM_MAX = 9999
const ITEM_SALE_PRICE = 50
const MAX_MANA = require("../assets/config.json").max_mana
const originalTimeOffset = getTimeOffset()

initializeDatabase()
setServerTimeOffset(FIXED_TIME - Date.now())

function createInput(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const characterId = Number(Object.keys(getPlayerCharactersSync(playerId))[0])
    const questData = {
        ...getQuestFromCategorySync(QuestCategory.HARD_MULTI_EVENT, QUEST_ID),
        clearReward: { type: RewardType.ITEM, id: ITEM_ID, count: 1 },
        sPlusReward: undefined,
        scoreRewardGroupId: 0,
        scoreRewardGroup: [],
        periodicRewardGroupId: undefined,
        periodicRewardSlots: undefined,
    }
    const settlementTime = new Date(FIXED_TIME)
    const fixedManaReward = calculateFixedQuestMana(
        questData.manaReward,
        getRewardCampaignRates(
            QuestCategory.HARD_MULTI_EVENT,
            QUEST_ID,
            settlementTime,
        ),
        false,
    )
    const capacityBeforeSold = 25
    const freeMana = MAX_MANA - fixedManaReward - capacityBeforeSold
    updatePlayerSync({
        id: playerId,
        freeMana,
        paidMana: 0,
        totalManaObtained: 100,
    })
    setInventoryFixtureItemExactSync(playerId, ITEM_ID, ITEM_MAX)
    const playId = `multi-overflow-${label}`
    const activeQuest = {
        questId: QUEST_ID,
        category: QuestCategory.HARD_MULTI_EVENT,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: true,
        coordinatorOrigin: "remote",
        roomNumber: "123456",
        battleSessionId: "123e4567-e89b-42d3-a456-426614174099",
        matePlayerIds: [],
        mateComIds: [],
        entryItemId: null,
        entryItemCount: null,
        staminaCost: 0,
        dailyChallengePointId: null,
        eventId: null,
        rescueFragmentEligible: false,
        playId,
        continueCount: 0,
    }
    insertActiveQuest(playerId, activeQuest)
    const statistics = {
        clear_phase: 1,
        max_combo_count: 0,
        party: {
            ability_soul_ids: [null, null, null],
            characters: [{ id: characterId }, null, null],
            equipments: [null, null, null],
            unison_characters: [null, null, null],
        },
        zones: [{ use_power_flip_count: 1 }],
    }
    const body = {
        add_mana: 0,
        api_count: 1,
        category: QuestCategory.HARD_MULTI_EVENT,
        continue_count: 0,
        elapsed_time_ms: 1000,
        is_accomplished: true,
        mate_player_result: [],
        play_id: playId,
        quest_id: QUEST_ID,
        room_number: activeQuest.roomNumber,
        score: 0,
        statistics,
        viewer_id: 990000001,
    }
    return {
        activeQuest,
        before: getPlayerSync(playerId),
        body,
        fixedManaReward,
        input: {
            activeQuest,
            body,
            finishValidation: {
                addMana: 0,
                elapsedTimeMs: 1000,
                score: 0,
                statistics,
            },
            isRoomHost: true,
            playerId,
            questData,
        },
        playerId,
    }
}

test("Multi base Mana and sellable clear overflow share one authoritative Player chain", async () => {
    const fixture = createInput("success")
    const settlement = runMultiplayerSettlementOrchestration(fixture.input)
    const after = getPlayerSync(fixture.playerId)

    assert.equal(after.freeMana, MAX_MANA)
    assert.equal(
        after.totalManaObtained,
        fixture.before.totalManaObtained + fixture.fixedManaReward + 25,
    )
    assert.equal(getPlayerItemSync(fixture.playerId, ITEM_ID), ITEM_MAX)
    assert.equal(getPlayerActiveQuestSync(fixture.playerId), null)
    assert.deepEqual(settlement.clearReward.itemOverflowDispositions, [{
        kind: "sold",
        itemId: ITEM_ID,
        overflowAmount: 1,
        soldMana: ITEM_SALE_PRICE,
        manaBefore: MAX_MANA - 25,
        acceptedMana: 25,
        overflowMana: 25,
        manaAfter: MAX_MANA,
    }])
    const manaMails = getPlayerMailsSync(fixture.playerId, 1, 100, true)
        .filter(mail => mail.type === MailType.FREE_MANA)
    assert.deepEqual(manaMails.map(mail => mail.number), [25])

    const response = await projectMultiplayerFinishResponse({
        activeQuest: fixture.activeQuest,
        body: fixture.body,
        playerId: fixture.playerId,
        settlement,
        viewerId: fixture.body.viewer_id,
    })
    assert.equal(response.data.user_info.free_mana, MAX_MANA)
    assert.equal(response.data.item_list[ITEM_ID], ITEM_MAX)
    assert.deepEqual(response.data.over_max, [{
        process_type: 2,
        amount_sold: ITEM_SALE_PRICE,
        item: { item_id: ITEM_ID, number: 1 },
    }])
})

test("a late Multi active-quest delete failure rolls base Mana and Sold disposition back", () => {
    const fixture = createInput("rollback")
    const beforeMailCount = getPlayerMailsSync(fixture.playerId, 1, 100, true).length
    getDb().exec(`
        CREATE TRIGGER fail_multi_overflow_delete
        BEFORE DELETE ON players_active_quests
        WHEN OLD.player_id = ${fixture.playerId}
        BEGIN SELECT RAISE(ABORT, 'forced multi overflow delete failure'); END;
    `)
    try {
        assert.throws(
            () => runMultiplayerSettlementOrchestration(fixture.input),
            /forced multi overflow delete failure/,
        )
    } finally {
        getDb().exec("DROP TRIGGER fail_multi_overflow_delete")
    }

    const after = getPlayerSync(fixture.playerId)
    assert.equal(after.freeMana, fixture.before.freeMana)
    assert.equal(after.totalManaObtained, fixture.before.totalManaObtained)
    assert.equal(getPlayerItemSync(fixture.playerId, ITEM_ID), ITEM_MAX)
    assert.notEqual(getPlayerActiveQuestSync(fixture.playerId), null)
    assert.equal(
        getPlayerMailsSync(fixture.playerId, 1, 100, true).length,
        beforeMailCount,
    )
})

test.after(() => {
    for (const playerId of Object.keys(activeQuests)) delete activeQuests[playerId]
    closeDatabase()
    restoreContentSnapshot()
    setServerTimeOffset(originalTimeOffset)
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
