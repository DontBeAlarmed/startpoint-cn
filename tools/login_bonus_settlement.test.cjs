"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "login-bonus-settlement-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot({
    additionalTableNames: ["login_bonus.json"],
})
const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    confirmNormalLoginBonusShownSync,
    confirmLoginBonusesShownSync,
    getPlayerNormalLoginBonusProgressSync,
    settleLoginBonusesSync: settleLoginBonusesSyncImpl,
    settleNormalLoginBonusSync: settleNormalLoginBonusSyncImpl,
} = require("../src/lib/login-bonus")

function settleLoginBonusesSync(input) {
    return settleLoginBonusesSyncImpl({
        realNowMs: input.realNowMs ?? input.virtualNowMs,
        ...input,
    })
}

function settleNormalLoginBonusSync(input) {
    return settleNormalLoginBonusSyncImpl({
        realNowMs: input.realNowMs ?? input.virtualNowMs,
        ...input,
    })
}

const catalog = require("../assets/login_bonus.json")
let database

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

function at(value) {
    return Date.parse(value)
}

function genericGroup(groupType, entries, options = {}) {
    return {
        groupType,
        availableFromMs: options.availableFromMs ?? at("2024-08-01T00:00:00.000Z"),
        availableUntilMs: options.availableUntilMs ?? null,
        conditionPeriodFromMs: options.conditionPeriodFromMs ?? null,
        conditionPeriodUntilMs: options.conditionPeriodUntilMs ?? null,
        comebackInactivityDays: options.comebackInactivityDays ?? null,
        linkedComebackGroupId: options.linkedComebackGroupId ?? null,
        includeBeginner: options.includeBeginner ?? null,
        entries,
    }
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

test("Normal login reward grant is atomic and pending loads are idempotent", () => {
    const playerId = createPlayer("idempotent")
    const before = getPlayerSync(playerId)
    const virtualNowMs = at("2024-08-14T12:00:00.000Z")

    const first = settleNormalLoginBonusSync({ playerId, virtualNowMs, dailyResetHour: 5, catalog })
    const repeated = settleNormalLoginBonusSync({ playerId, virtualNowMs, dailyResetHour: 5, catalog })

    assert.equal(first.status, "granted")
    assert.deepEqual(first.bonus, {
        groupId: "normal_2022",
        groupType: "Normal",
        index: 1,
        receivedAt: Math.floor(virtualNowMs / 1000),
    })
    assert.equal(first.grant.aggregate.user_info.free_vmoney, 50)
    assert.equal(getPlayerSync(playerId).freeVmoney, before.freeVmoney + 50)
    assert.equal(repeated.status, "pending")
    assert.deepEqual(repeated.bonus, first.bonus)
    assert.equal(getPlayerSync(playerId).freeVmoney, before.freeVmoney + 50)

    assert.deepEqual(getPlayerNormalLoginBonusProgressSync(playerId), {
        groupId: "normal_2022",
        lastGrantedIndex: 1,
        lastGrantedBusinessDay: "2024-08-14",
        lastGrantedRealBusinessDay: "2024-08-14",
        receivedAt: Math.floor(virtualNowMs / 1000),
        shownAt: null,
    })
})

test("login rewards advance at the real 05:00 business-day boundary", () => {
    const playerId = createPlayer("real-business-day")
    const virtualNowMs = at("2024-08-14T12:00:00.000Z")
    const realBeforeResetMs = at("2024-08-14T20:59:00.000Z")
    const realAfterResetMs = at("2024-08-14T21:00:00.000Z")

    const first = settleNormalLoginBonusSync({
        playerId,
        virtualNowMs,
        realNowMs: realBeforeResetMs,
        dailyResetHour: 5,
        catalog,
    })
    assert.equal(first.status, "granted")
    confirmNormalLoginBonusShownSync(playerId, realBeforeResetMs + 1_000)

    const second = settleNormalLoginBonusSync({
        playerId,
        virtualNowMs,
        realNowMs: realAfterResetMs,
        dailyResetHour: 5,
        catalog,
    })
    assert.equal(second.status, "granted")
    assert.equal(second.bonus.index, 2)
})

test("virtual date movement alone does not advance login rewards", () => {
    const playerId = createPlayer("virtual-only")
    const realNowMs = at("2024-08-14T20:00:00.000Z")
    const first = settleNormalLoginBonusSync({
        playerId,
        virtualNowMs: at("2024-08-14T12:00:00.000Z"),
        realNowMs,
        dailyResetHour: 5,
        catalog,
    })
    assert.equal(first.status, "granted")
    confirmNormalLoginBonusShownSync(playerId, realNowMs + 1_000)

    const second = settleNormalLoginBonusSync({
        playerId,
        virtualNowMs: at("2024-08-15T12:00:00.000Z"),
        realNowMs,
        dailyResetHour: 5,
        catalog,
    })
    assert.equal(second.status, "none")
})

test("legacy progress establishes a real-day baseline without retroactive reward", () => {
    const playerId = createPlayer("legacy-real-day")
    database.prepare(`
        INSERT INTO players_login_bonus_progress (
            player_id, group_id, last_granted_index,
            last_granted_business_day, received_at, shown_at
        ) VALUES (?, 'normal_2022', 1, '2024-08-14', 1723636800, 1723636801)
    `).run(playerId)

    const realNowMs = at("2024-08-14T21:30:00.000Z")
    const baseline = settleNormalLoginBonusSync({
        playerId,
        virtualNowMs: at("2024-08-14T12:00:00.000Z"),
        realNowMs,
        dailyResetHour: 5,
        catalog,
    })
    assert.equal(baseline.status, "none")
    assert.equal(
        getPlayerNormalLoginBonusProgressSync(playerId).lastGrantedRealBusinessDay,
        "2024-08-15",
    )

    const next = settleNormalLoginBonusSync({
        playerId,
        virtualNowMs: at("2024-08-14T12:00:00.000Z"),
        realNowMs: at("2024-08-15T21:30:00.000Z"),
        dailyResetHour: 5,
        catalog,
    })
    assert.equal(next.status, "granted")
    assert.equal(next.bonus.index, 2)
})

test("one load grants Normal and multiple active non-premium groups in one pending batch", () => {
    const playerId = createPlayer("multiple-groups")
    const catalog = {
        normal: genericGroup("Normal", [
            { index: 1, rewards: [{ kind: 0, count: 10 }] },
            { index: 2, rewards: [{ kind: 0, count: 20 }] },
        ]),
        limited_a: genericGroup("Limited", [
            { index: 1, rewards: [{ kind: 0, count: 30 }] },
            { index: 2, rewards: [{ kind: 0, count: 40 }] },
        ]),
        limited_b: genericGroup("Limited", [
            { index: 1, rewards: [{ kind: 0, count: 50 }] },
        ]),
    }
    const first = settleLoginBonusesSync({
        playerId,
        virtualNowMs: at("2024-08-14T12:00:00.000Z"),
        dailyResetHour: 5,
        catalog,
    })
    assert.equal(first.status, "granted")
    assert.deepEqual(first.bonuses.map(bonus => [bonus.groupId, bonus.groupType, bonus.index]), [
        ["normal", "Normal", 1],
        ["limited_a", "Limited", 1],
        ["limited_b", "Limited", 1],
    ])
    const repeated = settleLoginBonusesSync({
        playerId,
        virtualNowMs: at("2024-08-15T12:00:00.000Z"),
        dailyResetHour: 5,
        catalog,
    })
    assert.equal(repeated.status, "pending")
    assert.equal(repeated.bonuses.length, 3)
    assert.equal(confirmLoginBonusesShownSync(playerId, at("2024-08-15T12:00:01.000Z")), true)

    const second = settleLoginBonusesSync({
        playerId,
        virtualNowMs: at("2024-08-15T12:00:00.000Z"),
        dailyResetHour: 5,
        catalog,
    })
    assert.equal(second.status, "granted")
    assert.deepEqual(second.bonuses.map(bonus => [bonus.groupId, bonus.index]), [
        ["normal", 2],
        ["limited_a", 2],
    ])
})

test("Limited groups stop at their last entry and never wrap after a time rollback", () => {
    const playerId = createPlayer("limited-end")
    const catalog = {
        limited: genericGroup("Limited", [
            { index: 1, rewards: [{ kind: 0, count: 10 }] },
        ]),
    }
    const now = at("2024-08-14T12:00:00.000Z")
    assert.equal(settleLoginBonusesSync({ playerId, virtualNowMs: now, dailyResetHour: 5, catalog }).status, "granted")
    assert.equal(confirmLoginBonusesShownSync(playerId, now + 1_000), true)
    assert.equal(settleLoginBonusesSync({
        playerId,
        virtualNowMs: now + 86_400_000,
        dailyResetHour: 5,
        catalog,
    }).status, "none")
    assert.equal(settleLoginBonusesSync({
        playerId,
        virtualNowMs: now - 86_400_000,
        dailyResetHour: 5,
        catalog,
    }).status, "none")
})

test("Comeback eligibility uses the previous login and ActiveUser linkage is mutually exclusive", () => {
    const playerId = createPlayer("comeback")
    const now = at("2024-08-15T12:00:00.000Z")
    const catalog = {
        comeback: genericGroup("Comeback", [
            { index: 1, rewards: [{ kind: 0, count: 10 }] },
            { index: 2, rewards: [{ kind: 0, count: 20 }] },
        ], {
            conditionPeriodFromMs: at("2024-07-01T00:00:00.000Z"),
            conditionPeriodUntilMs: at("2024-07-31T23:59:59.000Z"),
            comebackInactivityDays: 30,
        }),
        active: genericGroup("ActiveUser", [
            { index: 1, rewards: [{ kind: 0, count: 99 }] },
        ], { linkedComebackGroupId: "comeback" }),
    }
    const first = settleLoginBonusesSync({
        playerId,
        virtualNowMs: now,
        previousLastLoginMs: at("2024-07-10T12:00:00.000Z"),
        isBeginner: false,
        dailyResetHour: 5,
        catalog,
    })
    assert.equal(first.status, "granted")
    assert.deepEqual(first.bonuses.map(bonus => bonus.groupId), ["comeback"])
    assert.equal(confirmLoginBonusesShownSync(playerId, now + 1_000), true)

    const next = settleLoginBonusesSync({
        playerId,
        virtualNowMs: now + 86_400_000,
        previousLastLoginMs: now,
        dailyResetHour: 5,
        catalog,
    })
    assert.equal(next.status, "granted")
    assert.deepEqual(next.bonuses.map(bonus => [bonus.groupId, bonus.index]), [["comeback", 2]])
})

test("Comeback groups fail closed when the prior login is outside the CDN condition period", () => {
    const playerId = createPlayer("comeback-ineligible")
    const catalog = {
        comeback: genericGroup("Comeback", [
            { index: 1, rewards: [{ kind: 0, count: 10 }] },
        ], {
            conditionPeriodFromMs: at("2024-07-01T00:00:00.000Z"),
            conditionPeriodUntilMs: at("2024-07-31T23:59:59.000Z"),
            comebackInactivityDays: 30,
        }),
    }
    assert.equal(settleLoginBonusesSync({
        playerId,
        virtualNowMs: at("2024-08-15T12:00:00.000Z"),
        previousLastLoginMs: at("2024-08-01T12:00:00.000Z"),
        dailyResetHour: 5,
        catalog,
    }).status, "none")
})

test("shown acknowledgement is idempotent and same-day load does not grant again", () => {
    const playerId = createPlayer("shown")
    const virtualNowMs = at("2024-08-14T12:00:00.000Z")
    settleNormalLoginBonusSync({ playerId, virtualNowMs, dailyResetHour: 5, catalog })

    assert.equal(confirmNormalLoginBonusShownSync(playerId, virtualNowMs + 1_000), true)
    assert.equal(confirmNormalLoginBonusShownSync(playerId, virtualNowMs + 2_000), false)
    assert.equal(
        settleNormalLoginBonusSync({ playerId, virtualNowMs, dailyResetHour: 5, catalog }).status,
        "none",
    )
})

test("Normal cursor advances through CDN rewards and wraps at the group end", () => {
    const playerId = createPlayer("cycle")
    const start = at("2024-08-14T12:00:00.000Z")
    const initial = getPlayerSync(playerId)
    const initialItem101 = getPlayerItemSync(playerId, 101) ?? 0
    const initialItem100000 = getPlayerItemSync(playerId, 100000) ?? 0
    const initialItem10001 = getPlayerItemSync(playerId, 10001) ?? 0

    const indices = []
    for (let day = 0; day < 5; day++) {
        const now = start + day * 86_400_000
        const result = settleNormalLoginBonusSync({ playerId, virtualNowMs: now, dailyResetHour: 5, catalog })
        indices.push(result.bonus.index)
        confirmNormalLoginBonusShownSync(playerId, now + 1_000)
    }

    assert.deepEqual(indices, [1, 2, 3, 4, 1])
    const player = getPlayerSync(playerId)
    assert.equal(player.freeVmoney, initial.freeVmoney + 100)
    assert.equal(player.freeMana, initial.freeMana + 1500)
    assert.equal(player.expPool, initial.expPool + 5000)
    assert.equal(getPlayerItemSync(playerId, 101), initialItem101 + 6)
    assert.equal(getPlayerItemSync(playerId, 100000), initialItem100000 + 25)
    assert.equal(getPlayerItemSync(playerId, 10001), initialItem10001 + 1)
})

test("active CDN group changes reset the cursor to index 1", () => {
    const playerId = createPlayer("group-change")
    const customCatalog = {
        old: {
            groupType: "Normal",
            availableFromMs: at("2024-08-01T00:00:00.000Z"),
            availableUntilMs: at("2024-08-14T23:59:59.000Z"),
            entries: [
                { index: 1, rewards: [{ kind: 0, count: 10 }] },
                { index: 2, rewards: [{ kind: 0, count: 20 }] },
            ],
        },
        current: {
            groupType: "Normal",
            availableFromMs: at("2024-08-15T00:00:00.000Z"),
            availableUntilMs: null,
            entries: [
                { index: 1, rewards: [{ kind: 0, count: 30 }] },
                { index: 2, rewards: [{ kind: 0, count: 40 }] },
            ],
        },
    }
    const firstMs = at("2024-08-14T12:00:00.000Z")
    const secondMs = at("2024-08-15T12:00:00.000Z")

    const first = settleNormalLoginBonusSync({
        playerId, virtualNowMs: firstMs, dailyResetHour: 5, catalog: customCatalog,
    })
    confirmNormalLoginBonusShownSync(playerId, firstMs + 1_000)
    const second = settleNormalLoginBonusSync({
        playerId, virtualNowMs: secondMs, dailyResetHour: 5, catalog: customCatalog,
    })

    assert.deepEqual([first.bonus.groupId, first.bonus.index], ["old", 1])
    assert.deepEqual([second.bonus.groupId, second.bonus.index], ["current", 1])
})

test("virtual time rollback and CDN gaps do not grant rewards", () => {
    const playerId = createPlayer("rollback")
    const laterMs = at("2024-08-15T12:00:00.000Z")
    settleNormalLoginBonusSync({ playerId, virtualNowMs: laterMs, dailyResetHour: 5, catalog })
    confirmNormalLoginBonusShownSync(playerId, laterMs + 1_000)
    const beforeRollback = getPlayerSync(playerId)

    assert.equal(settleNormalLoginBonusSync({
        playerId,
        virtualNowMs: at("2024-08-14T12:00:00.000Z"),
        dailyResetHour: 5,
        catalog,
    }).status, "none")
    assert.equal(settleNormalLoginBonusSync({
        playerId,
        virtualNowMs: at("2020-06-01T12:00:00.000Z"),
        dailyResetHour: 5,
        catalog,
    }).status, "none")
    assert.equal(getPlayerSync(playerId).freeVmoney, beforeRollback.freeVmoney)
})

test("late progress write failure rolls back the granted inventory", t => {
    const playerId = createPlayer("rollback-write")
    const before = getPlayerSync(playerId)
    database.exec(`
        CREATE TRIGGER fail_login_bonus_progress
        BEFORE INSERT ON players_login_bonus_progress
        WHEN NEW.player_id = ${playerId}
        BEGIN
            SELECT RAISE(ABORT, 'forced login bonus progress failure');
        END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS fail_login_bonus_progress"))

    assert.throws(
        () => settleNormalLoginBonusSync({
            playerId,
            virtualNowMs: at("2024-08-14T12:00:00.000Z"),
            dailyResetHour: 5,
            catalog,
        }),
        /forced login bonus progress failure/i,
    )
    assert.equal(getPlayerSync(playerId).freeVmoney, before.freeVmoney)
    assert.equal(getPlayerNormalLoginBonusProgressSync(playerId), null)
})
