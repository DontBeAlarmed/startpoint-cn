require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { fork } = require("node:child_process")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-event-entry-facts-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let db
function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}
process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    getAuthoritativeEventEntryMissionIds,
    recordEventLoginMissionFactSync,
    recordRaidSummaryMissionFactSync,
    validateEventEntryRule,
} = require("../src/lib/mission/event-entry-facts")
const { getMissionMasterDefinition } = require("../src/lib/mission/master-data")
const eventRewards = require("../assets/mission_event_reward.json")

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-event-entry-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id

test("authoritative Event entry rules match official pattern, selector, period, and reward targets", () => {
    assert.deepEqual(getAuthoritativeEventEntryMissionIds(), [1225, 400053, 400071, 400089, 400093])

    const raidDefinition = getMissionMasterDefinition(3, 400053)
    assert.equal(validateEventEntryRule(raidDefinition, eventRewards[400053], {
        missionId: 400053,
        pattern: "raid_event_04_mission_set_01",
        patternType: 79,
        targets: [1],
        selectorKind: 16,
        eventId: 4,
    }), true)

    const malformedSelector = { ...raidDefinition, row: [...raidDefinition.row] }
    malformedSelector.row[7] = "17"
    assert.equal(validateEventEntryRule(malformedSelector, eventRewards[400053], {
        missionId: 400053,
        pattern: "raid_event_04_mission_set_01",
        patternType: 79,
        targets: [1],
        selectorKind: 16,
        eventId: 4,
    }), false)

    const malformedEvent = { ...raidDefinition, row: [...raidDefinition.row] }
    malformedEvent.row[8] = "5"
    assert.equal(validateEventEntryRule(malformedEvent, eventRewards[400053], {
        missionId: 400053,
        pattern: "raid_event_04_mission_set_01",
        patternType: 79,
        targets: [1],
        selectorKind: 16,
        eventId: 4,
    }), false)

    const malformedPeriod = { ...raidDefinition, enableEnd: "not-a-date" }
    assert.equal(validateEventEntryRule(malformedPeriod, eventRewards[400053], {
        missionId: 400053,
        pattern: "raid_event_04_mission_set_01",
        patternType: 79,
        targets: [1],
        selectorKind: 16,
        eventId: 4,
    }), false)

    const malformedRewards = structuredClone(eventRewards[400053])
    malformedRewards[1][0][1] = "2"
    assert.equal(validateEventEntryRule(raidDefinition, malformedRewards, {
        missionId: 400053,
        pattern: "raid_event_04_mission_set_01",
        patternType: 79,
        targets: [1],
        selectorKind: 16,
        eventId: 4,
    }), false)

    const whitespaceSelector = { ...raidDefinition, row: [...raidDefinition.row] }
    whitespaceSelector.row[7] = " 16 "
    assert.equal(validateEventEntryRule(whitespaceSelector, eventRewards[400053], {
        missionId: 400053,
        pattern: "raid_event_04_mission_set_01",
        patternType: 79,
        targets: [1],
        selectorKind: 16,
        eventId: 4,
    }), false, "selector 整数 token 不得接受首尾空白")

    const invalidCalendarDate = { ...raidDefinition, enableEnd: "2024-02-31 23:59:59" }
    assert.equal(validateEventEntryRule(invalidCalendarDate, eventRewards[400053], {
        missionId: 400053,
        pattern: "raid_event_04_mission_set_01",
        patternType: 79,
        targets: [1],
        selectorKind: 16,
        eventId: 4,
    }), false, "规范格式但不存在的日历日期必须拒绝")

    const loginDefinition = getMissionMasterDefinition(3, 1225)
    const emptyType = { ...loginDefinition, row: [...loginDefinition.row] }
    emptyType.row[2] = ""
    assert.equal(validateEventEntryRule(emptyType, eventRewards[1225], {
        missionId: 1225,
        pattern: "startdash_login",
        patternType: 0,
        targets: [1, 2, 3, 4, 5, 6],
    }), false, "type 0 不得由空 token 宽松转换得到")

    const whitespaceTarget = structuredClone(eventRewards[400053])
    whitespaceTarget[1][0][1] = " 1 "
    assert.equal(validateEventEntryRule(raidDefinition, whitespaceTarget, {
        missionId: 400053,
        pattern: "raid_event_04_mission_set_01",
        patternType: 79,
        targets: [1],
        selectorKind: 16,
        eventId: 4,
    }), false, "奖励 target 必须是严格整数 token")
})
test("Event login records one fact per CN natural day without historical backfill", () => {
    assert.equal(recordEventLoginMissionFactSync(playerId, new Date("2019-11-27T04:00:00.000Z")), true)
    assert.equal(recordEventLoginMissionFactSync(playerId, new Date("2019-11-27T15:59:59.999Z")), false)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[1225].progress, 1)

    assert.equal(recordEventLoginMissionFactSync(playerId, new Date("2019-11-27T16:00:00.000Z")), true)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[1225].progress, 2)

    assert.equal(recordEventLoginMissionFactSync(playerId, new Date("2019-12-10T04:00:00.000Z")), true)
    assert.equal(
        getPlayerCategoryMissionsSync(playerId, 3)[1225].progress,
        3,
        "一次晚到登录只能增加当天，不能补造中间历史天数",
    )
    assert.equal(recordEventLoginMissionFactSync(playerId, new Date("2019-12-20T04:00:00.000Z")), false)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[1225].progress, 3)
})

test("Event login day marker and mission progress roll back atomically", () => {
    const rollbackAccount = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `mission-event-entry-rollback-${randomUUID()}`,
        status: "normal",
    })
    const rollbackPlayerId = insertDefaultPlayerSync(rollbackAccount.id).id
    db.exec(`
        CREATE TRIGGER fail_event_login_progress
        BEFORE INSERT ON players_category_missions
        WHEN NEW.player_id = ${rollbackPlayerId} AND NEW.category = 3 AND NEW.id = 1225
        BEGIN
            SELECT RAISE(FAIL, 'forced event login progress failure');
        END
    `)
    assert.throws(
        () => recordEventLoginMissionFactSync(
            rollbackPlayerId,
            new Date("2019-11-27T04:00:00.000Z"),
        ),
        /forced event login progress failure/,
    )
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_event_mission_login_days
        WHERE player_id = ? AND mission_id = 1225
    `).get(rollbackPlayerId).count, 0)
    assert.equal(getPlayerCategoryMissionsSync(rollbackPlayerId, 3)[1225], undefined)
    db.exec("DROP TRIGGER fail_event_login_progress")

    assert.equal(recordEventLoginMissionFactSync(
        rollbackPlayerId,
        new Date("2019-11-27T04:00:00.000Z"),
    ), true)
    assert.equal(getPlayerCategoryMissionsSync(rollbackPlayerId, 3)[1225].progress, 1)
})

test("Raid summary fact only completes the matching open Event mission and is idempotent", () => {
    assert.equal(recordRaidSummaryMissionFactSync(playerId, 4, new Date("2024-05-23T04:00:00.000Z")), true)
    assert.equal(recordRaidSummaryMissionFactSync(playerId, 4, new Date("2024-05-24T04:00:00.000Z")), false)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[400053].progress, 1)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[400071], undefined)

    assert.equal(recordRaidSummaryMissionFactSync(playerId, 5, new Date("2024-05-24T04:00:00.000Z")), false)
    assert.equal(recordRaidSummaryMissionFactSync(playerId, 999, new Date("2024-05-24T04:00:00.000Z")), false)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[400071], undefined)
})

test("competing database connections claim one Event login marker for the same natural day", async () => {
    const competingAccount = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `mission-event-entry-competing-${randomUUID()}`,
        status: "normal",
    })
    const competingPlayerId = insertDefaultPlayerSync(competingAccount.id).id
    const workerPath = path.join(__dirname, "helpers/record-event-login-worker.cjs")
    const workers = []

    try {
        for (let index = 0; index < 4; index++) {
            const worker = fork(workerPath, [], {
                env: {
                    ...process.env,
                    DATA_DIR: databaseDirectory,
                    WDFP_DATABASE_DIR: "",
                    PLAYER_ID: String(competingPlayerId),
                    EVALUATION_TIME: "2019-11-27T04:00:00.000Z",
                },
                stdio: ["ignore", "ignore", "inherit", "ipc"],
            })
            await new Promise((resolve, reject) => {
                worker.once("message", message => message === "ready" ? resolve() : reject(new Error(String(message))))
                worker.once("error", reject)
            })
            workers.push(worker)
        }
        const results = await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
            worker.once("message", message => {
                if (message && typeof message === "object" && "error" in message) {
                    reject(new Error(message.error))
                    return
                }
                resolve(message.result)
            })
            worker.once("error", reject)
            worker.send("go")
        })))
        assert.deepEqual(results.toSorted(), [false, false, false, true])
        assert.equal(getPlayerCategoryMissionsSync(competingPlayerId, 3)[1225].progress, 1)
        assert.equal(db.prepare(`
            SELECT COUNT(*) AS count
            FROM players_event_mission_login_days
            WHERE player_id = ? AND mission_id = 1225
        `).get(competingPlayerId).count, 1)
    } finally {
        for (const worker of workers) worker.kill()
    }
})
