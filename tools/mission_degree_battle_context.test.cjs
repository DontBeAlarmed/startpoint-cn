require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-degree-battle-context-db-"))
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
    getDegreeMvpMissionIds,
    getExactDegreeQuestClearMissionIds,
    recordDegreeMissionBattleFacts,
} = require("../src/lib/mission/degree-battle-facts")
const { getMissionMasterDefinitions } = require("../src/lib/mission/master-data")
const { buildBattleMissionSettlementScopes } = require("../src/lib/mission/battle-facts")

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "context-scope-test",
    idpId: `degree-battle-context-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id

const degreeScope = scopes => scopes.find(scope => typeof scope === "object" && scope.category === 5)
const definitions = getMissionMasterDefinitions(5)
const missionIdsByConditionType = conditionType => definitions
    .filter(definition => Number(definition.row[3]) === conditionType)
    .map(definition => definition.missionId)
const containsAll = (missionIds, expected) => expected.every(id => missionIds.includes(id))

const mvpMissionIds = [...getDegreeMvpMissionIds()]
const exactMissionIds = [...getExactDegreeQuestClearMissionIds()]
const nonExactType23MissionIds = missionIdsByConditionType(23)
    .filter(missionId => !exactMissionIds.includes(missionId))
assert.equal(mvpMissionIds.length, 3)
assert.equal(exactMissionIds.length, 84)
assert.equal(nonExactType23MissionIds.length, 36)

const fallbackScopes = buildBattleMissionSettlementScopes([111001])
const fallbackDegreeScope = degreeScope(fallbackScopes)
assert.ok(fallbackDegreeScope)
assert.equal(
    containsAll(fallbackDegreeScope.missionIds, mvpMissionIds),
    true,
    "旧宽回退必须保留 type 19 MVP 候选",
)
assert.equal(
    containsAll(fallbackDegreeScope.missionIds, exactMissionIds),
    true,
    "旧宽回退必须保留精确 type 23 候选",
)
assert.equal(
    containsAll(fallbackDegreeScope.missionIds, nonExactType23MissionIds),
    true,
    "旧宽回退必须保留非精确 type 23 候选",
)

const contextualScopes = buildBattleMissionSettlementScopes([111001], [])
const contextualDegreeScope = degreeScope(contextualScopes)
assert.ok(contextualDegreeScope)
assert.equal(
    contextualDegreeScope.missionIds.some(id => mvpMissionIds.includes(id)),
    false,
    "无事实 contextual scope 不得保留 type 19 MVP 候选",
)
assert.equal(
    contextualDegreeScope.missionIds.some(id => exactMissionIds.includes(id)),
    false,
    "无事实 contextual scope 不得保留精确 type 23 候选",
)
assert.equal(
    containsAll(contextualDegreeScope.missionIds, nonExactType23MissionIds),
    true,
    "contextual scope 必须保留全部非精确 type 23 候选",
)
assert.equal(
    contextualDegreeScope.missionIds.length < fallbackDegreeScope.missionIds.length,
    true,
    "contextual scope 必须小于旧宽回退",
)

const restoredContextualScope = degreeScope(
    buildBattleMissionSettlementScopes([111001], [...mvpMissionIds, 31100]),
)
assert.equal(
    containsAll(restoredContextualScope.missionIds, [26000, 26010, 26020, 31100]),
    true,
    "本场 facts 返回的 MVP 和精确 type 23 必须加回 scope",
)

const characterRelatedMissionIds = definitions
    .filter(definition => Number(definition.row[3]) === 44)
    .map(definition => ({
        missionId: definition.missionId,
        characterId: Number(definition.row[15]),
    }))
    .filter(({ characterId }) => Number.isSafeInteger(characterId) && characterId > 0)
for (const { missionId, characterId } of characterRelatedMissionIds) {
    const expected = characterId === 111001
    assert.equal(
        contextualDegreeScope.missionIds.includes(missionId),
        expected,
        `contextual scope 必须保持角色 ${characterId} 相关候选 ${missionId} 的现有过滤语义`,
    )
}

const missionProgressBeforeFailure = getPlayerCategoryMissionsSync(playerId, 5)
assert.deepEqual(
    recordDegreeMissionBattleFacts({
        playerId,
        questCategory: 1,
        questId: 1001,
        questAccomplished: false,
        isMulti: true,
        isMvp: true,
    }, new Date("2024-08-14T12:00:00.000Z")),
    [],
    "失败战斗不得返回 Degree contextual IDs",
)
assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 5), missionProgressBeforeFailure)

const mvpResult = recordDegreeMissionBattleFacts({
    playerId,
    questCategory: 1,
    questId: 1001,
    questAccomplished: true,
    isMulti: true,
    isMvp: true,
}, new Date("2024-08-14T12:00:00.000Z"))
assert.deepEqual(mvpResult, mvpMissionIds)

const exactResult = recordDegreeMissionBattleFacts({
    playerId,
    questCategory: 2,
    questId: 1025001,
    questAccomplished: true,
    isMulti: false,
    isMvp: false,
}, new Date("2024-08-14T12:00:00.000Z"))
assert.equal(exactResult.length > 0, true)
assert.equal(exactResult.every(missionId => exactMissionIds.includes(missionId)), true)
const progressAfterExact = getPlayerCategoryMissionsSync(playerId, 5)
assert.deepEqual(
    exactResult.map(missionId => progressAfterExact[String(missionId)]?.progress),
    exactResult.map(() => 1),
)

const battleFactsSource = fs.readFileSync(path.join(__dirname, "../src/lib/mission/battle-facts.ts"), "utf8")
const singlePublicationSource = fs.readFileSync(
    path.join(__dirname, "../src/lib/quest/finish/single-mission-publication.ts"),
    "utf8",
)
const singleWritesSource = fs.readFileSync(
    path.join(__dirname, "../src/lib/quest/finish/single-settlement-writes.ts"),
    "utf8",
)
const multiOrchestratorSource = fs.readFileSync(
    path.join(__dirname, "../src/multi/settlement/orchestrator.ts"),
    "utf8",
)
assert.match(
    battleFactsSource,
    /const degreeMissionIds = recordDegreeMissionBattleFacts\(/,
    "通用战斗 facts 必须返回 Degree contextual IDs",
)
assert.match(
    singleWritesSource,
    /directDegreeMissionIds:\s*missionBattleFacts\.degreeMissionIds/,
    "单人结算必须复用通用 facts 返回结果",
)
assert.match(
    singlePublicationSource,
    /readonly directDegreeMissionIds:\s*readonly number\[\]/,
    "单人 publication 必须接受共享 facts 结果",
)
assert.match(
    singlePublicationSource,
    /input\.partyCharacterIds,\s*input\.directDegreeMissionIds/,
    "单人 publication 必须把共享 facts 结果传入 Degree scope",
)
assert.match(
    multiOrchestratorSource,
    /partyCharacterIdsArray,\s*missionBattleFacts\.degreeMissionIds/,
    "多人结算必须复用同一个通用 facts 返回结果",
)

console.log("mission degree battle context tests passed")
cleanup()
process.removeListener("exit", cleanup)
