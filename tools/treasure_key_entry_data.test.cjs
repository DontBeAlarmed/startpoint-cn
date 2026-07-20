const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "..")
const directWorkspaceRoot = path.resolve(projectRoot, "..")
const gitCommonDirectory = path.resolve(
    projectRoot,
    execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: projectRoot,
        encoding: "utf8",
    }).trim(),
)
const workspaceRoot = fs.existsSync(path.join(directWorkspaceRoot, "wf-assets-cn"))
    ? directWorkspaceRoot
    : path.resolve(path.dirname(gitCommonDirectory), "..")
const questEntryCosts = require(path.join(projectRoot, "assets/quest_entry_costs.json"))
const adventEventQuests = require(path.join(
    workspaceRoot,
    "wf-assets-cn/orderedmap/quest/event/advent_event_quest.json",
))
const challengeDungeonQuests = require(path.join(
    workspaceRoot,
    "wf-assets-cn/orderedmap/quest/event/challenge_dungeon_event_quest.json",
))

const treasureQuestIds = ["1038", "1039", "1040", "2001", "2002", "2003", "2004", "2005", "2006"]
const rawTreasureRows = []
function collectRawQuestRows(value, rows) {
    if (Array.isArray(value) && Array.isArray(value[0])) {
        rows.push(value[0])
        return
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const child of Object.values(value)) collectRawQuestRows(child, rows)
    }
}
collectRawQuestRows(challengeDungeonQuests, rawTreasureRows)

for (const questId of treasureQuestIds) {
    const row = rawTreasureRows.find(candidate => candidate[0] === questId)
    assert.ok(row, `missing raw treasure quest ${questId}`)
    assert.equal(Number(row[56]), 1, `treasure quest ${questId} must use Always item mode`)
    assert.deepEqual(
        questEntryCosts[`13_${questId}`],
        {
            itemId: Number(row[57]),
            itemCount: Number(row[58]),
            stamina: Number(row[70]),
        },
        `challenge dungeon quest ${questId} must preserve entry fields 57/58/70`,
    )
}

const adventTicketQuestIds = ["200013009", "200021009", "200050009", "200071009", "200076009"]
const rawAdventRows = []
for (const eventRows of Object.values(adventEventQuests)) {
    for (const wrapper of Object.values(eventRows)) {
        if (Array.isArray(wrapper) && Array.isArray(wrapper[0])) rawAdventRows.push(wrapper[0])
    }
}

for (const questId of adventTicketQuestIds) {
    const row = rawAdventRows.find(candidate => candidate[0] === questId)
    assert.ok(row, `missing raw advent ticket quest ${questId}`)
    assert.equal(Number(row[61]), 1, `advent quest ${questId} must use Always item mode`)
    assert.deepEqual(
        questEntryCosts[`7_${questId}`],
        {
            itemId: Number(row[62]),
            itemCount: Number(row[63]),
            stamina: Number(row[75]),
        },
        `advent quest ${questId} must preserve entry fields 62/63/75`,
    )
}

const routeSource = fs.readFileSync(
    path.join(projectRoot, "src/routes/api/singleBattleQuest.ts"),
    "utf8",
)
const activeQuestServiceSource = fs.readFileSync(
    path.join(projectRoot, "src/lib/quest/active-quest-service.ts"),
    "utf8",
)
const insertActiveQuestSource = activeQuestServiceSource.slice(
    activeQuestServiceSource.indexOf("export function insertActiveQuest"),
    activeQuestServiceSource.indexOf("export function runAbortActiveQuestTransaction"),
)
assert.ok(
    insertActiveQuestSource.indexOf("persistActiveQuest")
        < insertActiveQuestSource.indexOf("publishActiveQuest"),
    "insertActiveQuest must persist to DB before publishing to memory",
)
assert.match(
    routeSource,
    /["']item_list["']\s*:\s*buildStartEntryItemList\(startResult\)/,
    "quest start response must include the post-deduction item_list",
)

console.log("treasure key entry data tests passed")
