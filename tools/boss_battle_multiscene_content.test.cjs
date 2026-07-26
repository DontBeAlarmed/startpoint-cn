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
const rawQuests = JSON.parse(fs.readFileSync(
    path.join(workspaceRoot, "wf-assets-cn/orderedmap/quest/boss_battle_quest.json"),
    "utf8",
))
const bundledQuests = require(path.join(projectRoot, "assets/boss_battle_quest.json"))

const converted = JSON.parse(execFileSync("python3", [
    "-c",
    [
        "import json, sys",
        "sys.path.insert(0, 'scripts')",
        "from converters import convert_boss_quests",
        "print(json.dumps(convert_boss_quests(json.load(sys.stdin))))",
    ].join(";"),
], {
    cwd: projectRoot,
    input: JSON.stringify(rawQuests),
    encoding: "utf8",
}))

const rows = Object.values(rawQuests).flatMap(chapters => (
    Object.values(chapters).flatMap(stages => Object.values(stages).map(wrapper => wrapper[0]))
))
const bothBossIds = []
for (const row of rows) {
    const questId = String(row[0])
    const isBothBoss = row[122] === "true"
    const expected = isBothBoss ? true : undefined
    assert.equal(converted[questId].isBothBoss, expected, `converter ${questId}`)
    assert.equal(bundledQuests[questId].isBothBoss, expected, `bundle ${questId}`)
    if (isBothBoss) bothBossIds.push(Number(questId))
}

assert.deepEqual(bothBossIds, [1001002, 1001003])
console.log("boss battle multiscene content tests passed")
