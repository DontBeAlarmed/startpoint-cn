"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-anniversary-replay-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let restoreContentSnapshot = () => {}
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { initializeDatabase, closeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { recordDailyMissionBattleFacts } = require("../src/lib/mission/daily-battle-facts")
const { recordCollectMissionBattleFacts } = require("../src/lib/mission/collect-battle-facts")
const { settleMissionCategories } = require("../src/lib/mission/settlement")
const { getMissionCatalog, isMissionMasterDefinitionEnabledAt } = require("../src/lib/mission/mission-catalog")
const { getMissionRequirementDraft } = require("../src/lib/mission/requirements/providers")
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
const REPLAY_TIME = new Date("2022-10-01T12:00:00.000Z")
setServerTimeOffset(REPLAY_TIME.getTime() - Date.now())

initializeDatabase()

// Window overlap: 2022-09-15 .. 2022-11-15 CN.
const WINDOW_START = Date.parse("2022-09-15T00:00:00.000Z") - 8 * 3600_000
const WINDOW_END = Date.parse("2022-11-16T00:00:00.000Z") - 8 * 3600_000

function inAnniversaryWindow(definition) {
    const catalog = getMissionCatalog()
    const start = catalog === null ? undefined : definition.enableStart
    return start !== undefined
        && Date.parse(start) - 8 * 3600_000 <= WINDOW_END
        && (definition.enableEnd === undefined
            || Date.parse(definition.enableEnd) - 8 * 3600_000 >= WINDOW_START)
}

// Every daily and collect mission whose window overlaps the anniversary
// replay must be routed (computed or persisted); the only exceptions are
// the documented out-of-scope shapes with named reasons.
const ALLOWED_UNSUPPORTED = new Set([
    "rescue-source-unavailable",
])

test("every anniversary-window daily and collect mission is routed at replay time", () => {
    const catalog = getMissionCatalog()
    const unrouted = []
    for (const category of [2, 4]) {
        for (const definition of catalog.getDefinitions(category)) {
            if (!inAnniversaryWindow(definition)) continue
            const draft = getMissionRequirementDraft(definition, catalog)
            if (draft.mode !== "unsupported") continue
            if (ALLOWED_UNSUPPORTED.has(draft.reason ?? "")) continue
            unrouted.push(`${category}:${definition.missionId}:${draft.reason}`)
        }
    }
    assert.deepEqual(unrouted, [], "一周年窗口内不得存在未具名豁免的未路由每日/收集任务")
})

test("a coop boss clear at replay time feeds both chains end to end", () => {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `anniversary-replay-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const player = insertDefaultPlayerSync(account.id) // placeholder; use real player below
    void player
    const context = {
        playerId,
        questCategory: 2,
        questId: 1009001,
        questAccomplished: true,
        clearTime: 1000,
        clearRank: 5,
        party: { characters: [], unison_characters: [] },
        statistics: {
            clear_phase: 1,
            party: { characters: [], unison_characters: [] },
            zones: [],
        },
        player: { id: playerId },
        questPreviouslyCompleted: false,
        questProgress: null,
        isMulti: true,
        isMultiHost: true,
    }
    const daily = recordDailyMissionBattleFacts(context, REPLAY_TIME)
    assert.ok(daily.length > 0, "重放时刻的协力领主战必须推进至少一条每日任务")
    // The anniversary collect rows are item/dependency/action shapes — no
    // collect battle mission is open at this instant, so the producer must
    // be an empty no-op rather than a phantom increment.
    assert.deepEqual(
        recordCollectMissionBattleFacts(context, REPLAY_TIME),
        [],
        "无开放收集战斗任务时必须是空 no-op",
    )

    const dailyProgress = getPlayerCategoryMissionsSync(playerId, 2)
    for (const missionId of daily) assert.ok((dailyProgress[missionId]?.progress ?? 0) >= 1)
    const settlement = settleMissionCategories(playerId, [2, 4], REPLAY_TIME)
    assert.ok(Array.isArray(settlement.missionInfo))
})

test.after(() => {
    setServerTimeOffset(previousTimeOffset)
    closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
