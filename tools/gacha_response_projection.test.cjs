"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const { projectGachaExecResponse } = require("../src/lib/gacha-owner/response-projector")
const { projectGachaExchangeResponse } = require("../src/lib/gacha-owner/exchange-response-projector")
const {
    projectCrazyGachaCandidateResponse,
    projectCrazyGachaSelectResponse,
} = require("../src/lib/gacha-owner/crazy-response-projector")

function execCharacterSuccess(overrides = {}) {
    return {
        ok: true,
        kind: "character",
        playerId: 9,
        gachaId: 1638,
        freeVmoney: 850,
        paidVmoney: 0,
        exchangePoint: 1,
        isDailyFirst: true,
        isAccountFirst: true,
        mailArrived: false,
        ticketItemBalances: { 49001: 2 },
        campaignList: [],
        starsCampaignList: [],
        draw: [{ character_id: 111001, movie_id: "normal", seed: 101, entry_count: 1 }],
        characters: [],
        rewardItems: {},
        itemOverflowDispositions: [],
        postCommitEffects: [],
        ...overrides,
    }
}

function execEquipmentSuccess(overrides = {}) {
    return {
        ...execCharacterSuccess(),
        kind: "equipment",
        draw: [{ equipment_id: 5020008, treasure_up_type: 0 }],
        equipment: [{
            equipment_id: 5020008,
            protection: false,
            level: 1,
            enhancement_level: 0,
            stack: 0,
        }],
        isErupt: false,
        ...overrides,
    }
}

test("exec projection applies the character whitelist and canonical identity", () => {
    const response = projectGachaExecResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: execCharacterSuccess(),
        postCommit: {
            characterList: [
                { character_id: 111001, stack: 0, junk_field: "leak" },
            ],
        },
    }).data
    assert.deepEqual(response.character_list, [{ character_id: 111001, stack: 0 }])
    assert.deepEqual(response.item_list, { 49001: 2 })
    assert.equal(response.mail_arrived, false)
    assert.throws(() => projectGachaExecResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: execCharacterSuccess(),
        postCommit: { characterList: [{ character_id: 0 }] },
    }), TypeError)
})

test("exec projection requires complete equipment entities", () => {
    const response = projectGachaExecResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: execEquipmentSuccess(),
        postCommit: { characterList: [] },
    }).data
    assert.deepEqual(response.equipment_list, [{
        equipment_id: 5020008,
        protection: false,
        level: 1,
        enhancement_level: 0,
        stack: 0,
    }])
    assert.equal("character_list" in response, false)
    assert.throws(() => projectGachaExecResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: execEquipmentSuccess({
            equipment: [{ equipment_id: 5020008, stack: 0 }],
        }),
        postCommit: { characterList: [] },
    }), TypeError)
})

function exchangeSuccess(overrides = {}) {
    return {
        ok: true,
        kind: "character",
        playerId: 9,
        gachaId: 1638,
        targetId: 1638,
        exchangePoint: 1,
        isDailyFirst: true,
        isAccountFirst: true,
        mailArrived: true,
        rewardItems: {},
        itemOverflowDispositions: [],
        postCommitEffects: [],
        ...overrides,
    }
}

test("exchange projection keeps frozen shapes while validating entities", () => {
    const characterResponse = projectGachaExchangeResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: exchangeSuccess({ playerAfter: { freeMana: 5, freeVmoney: 6, expPool: 7 } }),
        postCommit: {
            characterList: [{ character_id: 111001, stack: 1, junk_field: "leak" }],
        },
    }).data
    assert.deepEqual(characterResponse.character_list, [{ character_id: 111001, stack: 1 }])
    assert.deepEqual(characterResponse.item_list, [])
    assert.deepEqual(characterResponse.user_info, { free_mana: 5 })
    assert.equal(characterResponse.mail_arrived, true)
    assert.equal("equipment_list" in characterResponse, false)

    const equipmentResponse = projectGachaExchangeResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: exchangeSuccess({
            kind: "equipment",
            equipment: [{
                equipment_id: 5020008,
                protection: true,
                level: 2,
                enhancement_level: 1,
                stack: 3,
            }],
        }),
        postCommit: { characterList: [] },
    }).data
    assert.deepEqual(equipmentResponse.equipment_list, [{
        equipment_id: 5020008,
        protection: true,
        level: 2,
        enhancement_level: 1,
        stack: 3,
    }])
    assert.equal("item_list" in equipmentResponse, false)
    assert.equal("character_list" in equipmentResponse, false)
    assert.throws(() => projectGachaExchangeResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: exchangeSuccess({
            kind: "equipment",
            equipment: [{ equipment_id: 5020008 }],
        }),
        postCommit: { characterList: [] },
    }), TypeError)
})

function crazySelectSuccess(overrides = {}) {
    return {
        ok: true,
        kind: "crazySelect",
        playerId: 9,
        gachaId: 1638,
        mailArrived: false,
        rewardItems: { 49001: 1 },
        itemOverflowDispositions: [],
        postCommitEffects: [],
        ...overrides,
    }
}

test("crazy select projection applies the character whitelist and canonical identity", () => {
    const response = projectCrazyGachaSelectResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: crazySelectSuccess({
            playerAfter: { freeMana: 5, freeVmoney: 6, expPool: 7 },
        }),
        postCommit: {
            characterList: [{ character_id: 111001, stack: 0, junk_field: "leak" }],
        },
    }).data
    assert.deepEqual(response.character_list, [{ character_id: 111001, stack: 0 }])
    assert.deepEqual(response.item_list, { 49001: 1 })
    assert.deepEqual(response.user_info, { free_mana: 5, free_vmoney: 6 })
    assert.deepEqual(response.crazy_gacha_result_list, {})
    assert.throws(() => projectCrazyGachaSelectResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: crazySelectSuccess(),
        postCommit: { characterList: [{ character_id: -1 }] },
    }), TypeError)
})

test("crazy candidate projection publishes tickets as the common item map", () => {
    const response = projectCrazyGachaCandidateResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: {
            ok: true,
            kind: "crazyCandidate",
            playerId: 9,
            gachaId: 1638,
            exchangePoint: 2,
            isDailyFirst: false,
            isAccountFirst: false,
            crazyDrawCount: 3,
            ticketItemBalances: { 49001: 4 },
            draw: [{ character_id: 111001, movie_id: "normal", seed: 101 }],
            slots: { 1: [111001, 111002] },
        },
    }).data
    assert.deepEqual(response.item_list, { 49001: 4 })
    assert.equal("user_info" in response, false)
    assert.equal("mail_arrived" in response, false)
})

test("gacha response projection modules are dependency-free from DB, Content, and routes", () => {
    for (const module of [
        "../src/lib/gacha-owner/response-projector",
        "../src/lib/gacha-owner/exchange-response-projector",
        "../src/lib/gacha-owner/crazy-response-projector",
    ]) {
        const source = fs.readFileSync(
            path.join(__dirname, "..", module.replace("../", "") + ".ts"),
            "utf8",
        )
        assert.doesNotMatch(
            source,
            /(?:from\s+["'][^"']*(?:\/data|\/content|\/routes)|require\([^)]*(?:\/data|\/content|\/routes))/i,
            module,
        )
    }
    const loaded = Object.keys(require.cache)
    assert.equal(
        loaded.some(file => /\/src\/(data|content|routes)\//.test(file)),
        false,
    )
})
