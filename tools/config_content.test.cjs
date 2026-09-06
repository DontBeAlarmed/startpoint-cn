"use strict"

const assert = require("node:assert/strict")
const { performance } = require("node:perf_hooks")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    getCrazyGachaPolicySync,
    getCurrencyCapacityPolicySync,
    getEquipmentCurrencyPolicySync,
    getMultiRewardPolicySync,
    getSingleContinuePolicySync,
    getStaminaPolicySync,
} = require("../src/lib/config-content")
const {
    createFrozenTestContentRepository,
} = require("./helpers/content-snapshot-fixture.cjs")
const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")

function rawConfig(overrides = {}) {
    return {
        max_virtual_money: 999999,
        max_mana: 99999999,
        max_star_crumb: 9999,
        stamina_recovery_virtual_money: 50,
        stamina_recovery_seconds: 300,
        stamina_recovery_value: 100,
        max_stamina_overflow: 999,
        craft_point_item_id: 100000,
        star_grain_item_id: 990008,
        continue_virtual_money: 50,
        common_reward_multiplier_by_multi_play_mode: 1,
        gacha_crazy_ten_max_count: 999,
        ...overrides,
    }
}

function countedRepository(config) {
    const inner = createFrozenTestContentRepository({
        assetVersion: "same-version",
        tables: { "config.json": config },
    })
    let reads = 0
    return {
        repository: Object.freeze({
            info: () => inner.info(),
            table(tableName) {
                reads++
                return inner.table(tableName)
            },
        }),
        reads: () => reads,
    }
}

test("narrow Config policies cache by repository identity and read raw Config once", () => {
    const first = countedRepository(rawConfig())
    const currency = getCurrencyCapacityPolicySync(first.repository)
    assert.strictEqual(getCurrencyCapacityPolicySync(first.repository), currency)
    assert.deepEqual(currency, { maxVmoney: 999999, maxMana: 99999999, maxStarCrumb: 9999 })
    assert.deepEqual(getStaminaPolicySync(first.repository), {
        recoveryVmoneyCost: 50,
        recoverySeconds: 300,
        recoveryValue: 100,
        maxOverflow: 999,
    })
    assert.deepEqual(getEquipmentCurrencyPolicySync(first.repository), {
        craftPointItemId: 100000,
        starGrainItemId: 990008,
    })
    assert.deepEqual(getSingleContinuePolicySync(first.repository), { vmoneyCost: 50 })
    assert.deepEqual(getMultiRewardPolicySync(first.repository), { commonRewardMultiplier: 1 })
    assert.deepEqual(getCrazyGachaPolicySync(first.repository), { tenDrawMaxCount: 999 })
    assert.equal(first.reads(), 1)
    assert.equal(Object.isFrozen(currency), true)

    const second = countedRepository(rawConfig({ max_mana: 7 }))
    assert.notStrictEqual(
        getCurrencyCapacityPolicySync(second.repository),
        currency,
    )
    assert.equal(getCurrencyCapacityPolicySync(second.repository).maxMana, 7)
    assert.equal(second.reads(), 1)
})

test("each policy validates only its consumed fields and preserves zero semantics", () => {
    const isolated = countedRepository(rawConfig({ gacha_crazy_ten_max_count: "broken" }))
    assert.equal(getCurrencyCapacityPolicySync(isolated.repository).maxMana, 99999999)
    assert.throws(() => getCrazyGachaPolicySync(isolated.repository), /gacha_crazy_ten_max_count/)

    const zeros = countedRepository(rawConfig({
        max_virtual_money: 0,
        max_mana: 0,
        max_star_crumb: 0,
        stamina_recovery_virtual_money: 0,
        stamina_recovery_value: 0,
        max_stamina_overflow: 0,
        craft_point_item_id: 0,
        star_grain_item_id: 0,
        continue_virtual_money: 0,
        common_reward_multiplier_by_multi_play_mode: 0,
        gacha_crazy_ten_max_count: 0,
    }))
    assert.deepEqual(getCurrencyCapacityPolicySync(zeros.repository), {
        maxVmoney: 0,
        maxMana: 0,
        maxStarCrumb: 0,
    })
    assert.deepEqual(getEquipmentCurrencyPolicySync(zeros.repository), {
        craftPointItemId: 100000,
        starGrainItemId: 990008,
    })
    assert.equal(getStaminaPolicySync(zeros.repository).recoveryValue, 0)
    assert.equal(getSingleContinuePolicySync(zeros.repository).vmoneyCost, 0)
    assert.equal(getMultiRewardPolicySync(zeros.repository).commonRewardMultiplier, 0)
    assert.equal(getCrazyGachaPolicySync(zeros.repository).tenDrawMaxCount, 0)
})

test("missing, coerced and unsafe Config fields fail closed", () => {
    for (const [field, value, read] of [
        ["max_mana", "999", getCurrencyCapacityPolicySync],
        ["max_virtual_money", false, getCurrencyCapacityPolicySync],
        ["max_star_crumb", -1, getCurrencyCapacityPolicySync],
        ["stamina_recovery_seconds", 0, getStaminaPolicySync],
        ["stamina_recovery_value", Number.NaN, getStaminaPolicySync],
        ["continue_virtual_money", Number.MAX_SAFE_INTEGER + 1, getSingleContinuePolicySync],
        ["common_reward_multiplier_by_multi_play_mode", Number.POSITIVE_INFINITY, getMultiRewardPolicySync],
    ]) {
        const config = rawConfig({ [field]: value })
        const fixture = countedRepository(config)
        assert.throws(() => read(fixture.repository), new RegExp(field))
    }
    const missing = rawConfig()
    delete missing.max_mana
    const fixture = countedRepository(missing)
    assert.throws(() => getCurrencyCapacityPolicySync(fixture.repository), /max_mana/)
})

test("default production lookup fails before the Content snapshot is initialized", () => {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    productionContentSnapshotProvider.snapshot = null
    try {
        assert.throws(
            () => getCurrencyCapacityPolicySync(),
            error => error?.code === "CONTENT_SNAPSHOT_NOT_INITIALIZED",
        )
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
})

test("cached narrow Config hot lookup stays below the fixed admission", () => {
    const fixture = countedRepository(rawConfig())
    getCurrencyCapacityPolicySync(fixture.repository)
    const startedAt = performance.now()
    for (let index = 0; index < 100_000; index++) {
        getCurrencyCapacityPolicySync(fixture.repository)
    }
    const durationMs = performance.now() - startedAt
    assert.ok(durationMs < 500, `100k Config policy lookups took ${durationMs.toFixed(1)}ms`)
    assert.equal(fixture.reads(), 1)
})
