"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const { finishPayload } = require("./perf/single_battle_settlement_harness.cjs")
const {
    validateSingleFinishRequest,
} = require("../src/lib/quest/single-finish-validation")

const INVALID_MESSAGE = "Invalid request body."
const INT32_MAX = 2_147_483_647
const TOP_LEVEL_SAFE_INTEGER_FIELDS = [
    "max_combo_count",
    "max_power",
    "max_skill_chain_count",
    "overflow_damge_count",
]
const ZONE_SAFE_INTEGER_FIELDS = [
    "use_power_flip_count",
    "use_dash_count",
    "use_skill_count",
    "send_emotion_count",
    "fever_count",
    "fever_ms",
    "use_debuff_to_enemy_count",
    "clear_buff_of_enemy_count",
    "clear_debuff_of_self_count",
    "use_buff_to_all_party_members",
    "use_emotion_count",
    "enemy_kill_count",
    "weak_point_attack_count",
    "use_power_flip_lv3_count",
    "coffin_count_reduced_count",
    "max_coffin_count_by_revival",
    "encoffinment_count",
]
const ZONE_FINITE_NUMBER_FIELDS = [
    "use_heal_to_all_party_members",
    "damage_deal_max",
    "damage_deal_total",
]

function minimalFinishBody() {
    return {
        viewer_id: 1,
        play_id: "single-finish-validation",
        quest_id: 1,
        category: 1,
        continue_count: 0,
        add_mana: 0,
        elapsed_time_ms: 1,
        score: 0,
        is_accomplished: true,
        is_restored: false,
        statistics: {
            clear_phase: 0,
            zones: [{}],
            party: {
                characters: [{ id: 1 }],
                unison_characters: [null],
                equipments: [],
                ability_soul_ids: [],
            },
        },
    }
}

function historyFinishBody(category = 15) {
    const body = minimalFinishBody()
    body.category = category
    body.statistics.zones = [{
        damage_deal_total: 1,
        members: [{ origin_damage: 1 }, null, null],
    }]
    return body
}

function assertInvalid(body) {
    assert.deepEqual(validateSingleFinishRequest(body), {
        ok: false,
        message: INVALID_MESSAGE,
    })
}

test("single finish request validator exports a pure validation entry point", () => {
    let validationModule = null
    assert.doesNotThrow(() => {
        validationModule = require("../src/lib/quest/single-finish-validation")
    })
    assert.equal(typeof validationModule.validateSingleFinishRequest, "function")
})

test("single finish request validator accepts client-compatible payloads", () => {
    for (const [name, body] of [
        ["minimal with empty equipment and ability soul arrays", minimalFinishBody()],
        ["ordinary quest with empty zones", {
            ...minimalFinishBody(),
            statistics: { ...minimalFinishBody().statistics, zones: [] },
        }],
        ["practice history payload", historyFinishBody(15)],
        ["score attack history payload", historyFinishBody(27)],
        ["complete fixture", finishPayload()],
        ["fractional score", { ...finishPayload(), score: 0.5 }],
        ["empty unison characters", {
            ...minimalFinishBody(),
            statistics: {
                ...minimalFinishBody().statistics,
                party: {
                    ...minimalFinishBody().statistics.party,
                    unison_characters: [],
                },
            },
        }],
        ["extensions", {
            ...minimalFinishBody(),
            statistics: {
                ...minimalFinishBody().statistics,
                future_statistics_field: { accepted: true },
                zones: [{ future_zone_field: ["accepted"] }],
            },
            sub_statistics: { future_payload: true },
            equipment_element: [0, 1, Number.MAX_SAFE_INTEGER],
        }],
    ]) {
        const result = validateSingleFinishRequest(body)
        assert.equal(result.ok, true, name)
        assert.strictEqual(result.body, body, name)
    }
})

test("single finish request validator accepts finite fractional battle metrics", () => {
    const body = minimalFinishBody()
    body.statistics.zones = [{
        use_heal_to_all_party_members: 0.5,
        damage_deal_max: 0.5,
        damage_deal_total: 0.5,
        members: [{ debuff_r: 0, origin_damage: 0.5 }, null],
    }]

    const result = validateSingleFinishRequest(body)

    assert.equal(result.ok, true)
    assert.strictEqual(result.body, body)
})

test("single finish request validator rejects malformed scalar fields", async t => {
    const cases = [
        ["body null", null],
        ["body array", []],
        ["body date", new Date()],
        ...["viewer_id", "quest_id", "category"].flatMap(field => [
            [`${field} zero`, { field, value: 0 }],
            [`${field} fraction`, { field, value: 1.5 }],
            [`${field} unsafe`, { field, value: Number.MAX_SAFE_INTEGER + 1 }],
        ]),
        ["play_id empty", { field: "play_id", value: "" }],
        ["play_id non-string", { field: "play_id", value: 1 }],
        ...["continue_count", "add_mana"].flatMap(field => [
            [`${field} negative`, { field, value: -1 }],
            [`${field} fraction`, { field, value: 1.5 }],
            [`${field} unsafe`, { field, value: Number.MAX_SAFE_INTEGER + 1 }],
        ]),
        ["elapsed_time_ms zero", { field: "elapsed_time_ms", value: 0 }],
        ["elapsed_time_ms fraction", { field: "elapsed_time_ms", value: 1.5 }],
        ["score negative", { field: "score", value: -1 }],
        ["score infinity", { field: "score", value: Infinity }],
        ["score NaN", { field: "score", value: NaN }],
        ["is_accomplished non-boolean", { field: "is_accomplished", value: 1 }],
        ["is_restored non-boolean", { field: "is_restored", value: 0 }],
    ]

    for (const [name, mutation] of cases) {
        await t.test(name, () => {
            if (mutation === null || Array.isArray(mutation) || mutation instanceof Date) {
                assertInvalid(mutation)
                return
            }
            assertInvalid({ ...minimalFinishBody(), [mutation.field]: mutation.value })
        })
    }
})

test("single finish request validator rejects malformed statistics structure", async t => {
    const replaceStatistics = value => ({ ...minimalFinishBody(), statistics: value })
    const replaceParty = value => replaceStatistics({
        ...minimalFinishBody().statistics,
        party: value,
    })
    const replacePartyField = (field, value) => replaceParty({
        ...minimalFinishBody().statistics.party,
        [field]: value,
    })
    const omitStatisticsField = field => {
        const statistics = { ...minimalFinishBody().statistics }
        delete statistics[field]
        return replaceStatistics(statistics)
    }
    const cases = [
        ["statistics null", replaceStatistics(null)],
        ["statistics empty", replaceStatistics({})],
        ["statistics array", replaceStatistics([])],
        ["clear phase missing", omitStatisticsField("clear_phase")],
        ["clear phase negative", replaceStatistics({
            ...minimalFinishBody().statistics,
            clear_phase: -1,
        })],
        ["clear phase fraction", replaceStatistics({
            ...minimalFinishBody().statistics,
            clear_phase: 0.5,
        })],
        ["zones missing", omitStatisticsField("zones")],
        ["party missing", omitStatisticsField("party")],
        ["party array", replaceParty([])],
        ...["characters", "unison_characters", "equipments", "ability_soul_ids"]
            .map(field => [`${field} non-array`, replacePartyField(field, {})]),
        ["characters missing main slot", replacePartyField("characters", [])],
        ["characters without a positive id", replacePartyField("characters", [null, { id: null }])],
        ["characters member array", replacePartyField("characters", [[]])],
        ["characters member id missing", replacePartyField("characters", [{}])],
        ["characters member id zero", replacePartyField("characters", [{ id: 0 }])],
        ["unison member id fraction", replacePartyField("unison_characters", [{ id: 1.5 }])],
        ["equipment member id string", replacePartyField("equipments", [{ id: "1" }])],
        ["ability soul id zero", replacePartyField("ability_soul_ids", [0])],
        ["ability soul id unsafe", replacePartyField(
            "ability_soul_ids",
            [Number.MAX_SAFE_INTEGER + 1],
        )],
        ["zones non-array", {
            ...minimalFinishBody(),
            statistics: { ...minimalFinishBody().statistics, zones: {} },
        }],
        ["zones null member", {
            ...minimalFinishBody(),
            statistics: { ...minimalFinishBody().statistics, zones: [null] },
        }],
        ["zones primitive member", {
            ...minimalFinishBody(),
            statistics: { ...minimalFinishBody().statistics, zones: [1] },
        }],
    ]

    for (const [name, body] of cases) {
        await t.test(name, () => assertInvalid(body))
    }
})

test("single finish request validator rejects unsafe known battle metrics", async t => {
    for (const field of TOP_LEVEL_SAFE_INTEGER_FIELDS) {
        for (const [label, value] of [["fraction", 0.5], ["int32 overflow", INT32_MAX + 1]]) {
            await t.test(`statistics ${field} ${label}`, () => assertInvalid({
                ...minimalFinishBody(),
                statistics: { ...minimalFinishBody().statistics, [field]: value },
            }))
        }
    }
    for (const field of ZONE_SAFE_INTEGER_FIELDS) {
        for (const [label, value] of [["fraction", 0.5], ["int32 overflow", INT32_MAX + 1]]) {
            await t.test(`zone ${field} ${label}`, () => assertInvalid({
                ...minimalFinishBody(),
                statistics: {
                    ...minimalFinishBody().statistics,
                    zones: [{ [field]: value }],
                },
            }))
        }
    }
    for (const field of ZONE_FINITE_NUMBER_FIELDS) {
        await t.test(`zone ${field}`, () => assertInvalid({
            ...minimalFinishBody(),
            statistics: {
                ...minimalFinishBody().statistics,
                zones: [{ [field]: Infinity }],
            },
        }))
    }
    for (const [name, members] of [
        ["members non-array", {}],
        ["member primitive", [1]],
        ["member debuff unsafe", [{ debuff_r: 0.5 }]],
        ["member debuff int32 overflow", [{ debuff_r: INT32_MAX + 1 }]],
        ["member origin damage unsafe", [{ origin_damage: Infinity }]],
    ]) {
        await t.test(name, () => assertInvalid({
            ...minimalFinishBody(),
            statistics: {
                ...minimalFinishBody().statistics,
                zones: [{ members }],
            },
        }))
    }
})

test("single finish request validator enforces int32 statistic aggregates", async t => {
    const maxBody = minimalFinishBody()
    maxBody.statistics.clear_phase = INT32_MAX
    Object.assign(maxBody.statistics, Object.fromEntries(
        TOP_LEVEL_SAFE_INTEGER_FIELDS.map(field => [field, INT32_MAX]),
    ))
    maxBody.statistics.zones = [{
        ...Object.fromEntries(ZONE_SAFE_INTEGER_FIELDS.map(field => [field, INT32_MAX])),
        members: [{ debuff_r: INT32_MAX }],
    }]
    assert.equal(validateSingleFinishRequest(maxBody).ok, true)

    const clearPhaseOverflow = minimalFinishBody()
    clearPhaseOverflow.statistics.clear_phase = INT32_MAX + 1
    assertInvalid(clearPhaseOverflow)

    for (const field of ["use_power_flip_count", "use_dash_count"]) {
        await t.test(`${field} aggregate overflow`, () => {
            const body = minimalFinishBody()
            body.statistics.zones = [{ [field]: INT32_MAX }, { [field]: 1 }]
            assertInvalid(body)
        })
    }
})

test("single finish request validator rejects malformed history aggregates", async t => {
    const cases = [
        ["practice empty zones", 15, []],
        ["score attack empty zones", 27, []],
        ["practice missing total damage", 15, [{}]],
        ["score attack missing total damage", 27, [{}]],
        ["practice total damage overflow", 15, [
            { damage_deal_total: 1e308 },
            { damage_deal_total: 1e308 },
        ]],
        ["practice member damage overflow", 15, [
            { damage_deal_total: 1, members: [{ origin_damage: 1e308 }] },
            { damage_deal_total: 1, members: [{ origin_damage: 1e308 }] },
        ]],
    ]

    for (const [name, category, zones] of cases) {
        await t.test(name, () => {
            const body = historyFinishBody(category)
            body.statistics.zones = zones
            assertInvalid(body)
        })
    }
})

test("single finish request validator rejects malformed equipment elements", async t => {
    for (const [name, value] of [
        ["non-array", {}],
        ["negative", [-1]],
        ["fraction", [1.5]],
        ["unsafe", [Number.MAX_SAFE_INTEGER + 1]],
    ]) {
        await t.test(name, () => assertInvalid({
            ...minimalFinishBody(),
            equipment_element: value,
        }))
    }
})
