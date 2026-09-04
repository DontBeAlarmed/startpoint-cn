"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    projectGachaExecResponse,
    runGachaPostCommitEffects,
} = require("../src/lib/gacha-owner")
const {
    drawGachaBannerWithMetadata,
    selectCumulativeIndex,
} = require("../src/lib/gacha-catalog")

test("shared weighted pools preserve exact roll boundaries and ten-draw guarantee", () => {
    assert.equal(selectCumulativeIndex([2, 5, 10], 1), 0)
    assert.equal(selectCumulativeIndex([2, 5, 10], 2), 0)
    assert.equal(selectCumulativeIndex([2, 5, 10], 3), 1)
    assert.equal(selectCumulativeIndex([2, 5, 10], 10), 2)
    assert.equal(selectCumulativeIndex([2, 5, 10], 11), null)

    const poolsByRank = Object.fromEntries([1, 2, 3].map((rank, index) => [String(rank), {
        oddsId: `fixture_${rank}`,
        items: [{ id: 100 + rank, rank: 5 - index, odds: 1 }],
        cumulativeWeights: [1],
        totalWeight: 1,
    }]))
    const banner = {
        kind: "character",
        gachaId: 1,
        pageKind: 0,
        basePeriod: { availableFrom: "2024-01-01 00:00:00", availableUntil: "2024-12-31 23:59:59" },
        poolsByRank,
        definition: {
            kind: "character",
            rankRates: { normal: [0, 0, 1000], multiGuarantee: [0, 1000] },
        },
    }
    const draws = drawGachaBannerWithMetadata(banner, 10, maximum => maximum)
    assert.deepEqual(draws.slice(0, 9).map(draw => draw.rank), Array(9).fill(3))
    assert.deepEqual(draws[9], { id: 102, rank: 4, isGuarantee: true })
})

function characterSuccess() {
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
        ticketItemBalances: {},
        campaignList: [{ gachaId: 1638, campaignId: 77, count: 0 }],
        starsCampaignList: [{ campaignId: 1, freeOneTimes: 2, freeTenTimes: 3 }],
        draw: [{ character_id: 111001, movie_id: "normal", seed: 101, entry_count: 1 }],
        characters: [{ character_id: 111001, stack: 0 }],
        rewardItems: {},
        itemOverflowDispositions: [],
        postCommitEffects: [
            { kind: "seedMark", movieId: "normal", seed: 101, rarity: 5 },
            { kind: "seedMark", movieId: "normal", seed: 102, rarity: 4 },
            {
                kind: "sampledLog",
                playerId: 9,
                draws: [{ character_id: 111001, movie_id: "normal", seed: 101, entry_count: 1 }],
                moviePlans: [{
                    characterId: 111001,
                    movieId: "normal",
                    seed: 101,
                    rarity: 5,
                    requiresVerification: true,
                }],
            },
            {
                kind: "characterGrowthPublication",
                playerId: 9,
                characters: [{ character_id: 111001, stack: 0 }],
                source: "gacha/exec",
            },
        ],
    }
}

test("post-commit effects are data snapshots and failures stay isolated", () => {
    const result = characterSuccess()
    assert.doesNotMatch(JSON.stringify(result.postCommitEffects), /function|run/)
    const calls = []
    const originalError = console.error
    console.error = () => {}
    let postCommit
    try {
        postCommit = runGachaPostCommitEffects(result, {
            markSeed: (_movieId, seed) => {
                calls.push(`seed:${seed}`)
                if (seed === 101) throw new Error("fixture seed failure")
            },
            sampledCharacterLog: () => calls.push("log"),
            publishGrowth: () => {
                calls.push("growth")
                throw new Error("fixture growth failure")
            },
        })
    } finally {
        console.error = originalError
    }
    assert.deepEqual(calls, ["seed:101", "seed:102", "log", "growth"])
    assert.deepEqual(postCommit.characterList, result.characters)
})

test("response projector is database-free and keeps Character/Equipment shapes exclusive", () => {
    const character = characterSuccess()
    const characterResponse = projectGachaExecResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: character,
        postCommit: { characterList: character.characters },
    }).data
    assert.equal(characterResponse.mail_arrived, false)
    assert.equal(characterResponse.gacha_info_list[0].is_daily_first, true)
    assert.ok("draw" in characterResponse)
    assert.ok("character_list" in characterResponse)
    assert.deepEqual(characterResponse.gacha_campaign_list, [{
        gacha_id: 1638,
        campaign_id: 77,
        count: 0,
    }])
    assert.deepEqual(characterResponse.stars_gacha_campaign_list, [{
        campaign_id: 1,
        free_one_times: 2,
        free_ten_times: 3,
    }])
    assert.equal("draw_equipment" in characterResponse, false)
    assert.equal("equipment_list" in characterResponse, false)

    const equipment = {
        ...character,
        kind: "equipment",
        draw: [{ equipment_id: 5020008, treasure_up_type: 0 }],
        equipment: [{ equipment_id: 5020008, stack: 0 }],
        rewardItems: {},
        itemOverflowDispositions: [],
        isErupt: false,
        postCommitEffects: [],
    }
    const equipmentResponse = projectGachaExecResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: equipment,
        postCommit: { characterList: [] },
    }).data
    assert.ok("draw_equipment" in equipmentResponse)
    assert.ok("equipment_list" in equipmentResponse)
    assert.equal("draw" in equipmentResponse, false)
    assert.equal("character_list" in equipmentResponse, false)
    assert.equal("gacha_campaign_list" in equipmentResponse, false)
})
