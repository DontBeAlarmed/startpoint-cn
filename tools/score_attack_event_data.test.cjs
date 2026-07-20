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
const rawRoot = path.join(workspaceRoot, "wf-assets-cn", "orderedmap")

const rawQuests = JSON.parse(fs.readFileSync(
    path.join(rawRoot, "quest/event/score_attack_event_quest.json"),
    "utf8",
))
const rawBorderRewards = JSON.parse(fs.readFileSync(
    path.join(rawRoot, "quest/event/score_attack_border_reward.json"),
    "utf8",
))
const quests = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "assets/score_attack_event_quest.json"),
    "utf8",
))
const borderRewards = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "assets/score_attack_border_reward.json"),
    "utf8",
))
const entryCosts = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "assets/quest_entry_costs.json"),
    "utf8",
))
const fieldMap = JSON.parse(execFileSync("python3", [
    "-c",
    "import json,sys;sys.path.insert(0,'scripts');import field_map;print(json.dumps(field_map.SCORE_ATTACK))",
], { cwd: projectRoot, encoding: "utf8" }))

assert.deepEqual(fieldMap, {
    quest_id: 0,
    clear_reward: 6,
    score_group: 72,
    element: 73,
    rank_b: 52,
    rank_a: 53,
    rank_s: 54,
    rank_sp: 55,
    rank_point: 86,
    char_exp: 87,
    mana: 88,
    pool_exp: 89,
    fixed_party: -1,
    story_check: -1,
})

const converterSource = fs.readFileSync(
    path.join(projectRoot, "scripts/converters/quests/campaign.py"),
    "utf8",
)
for (const [field, index] of Object.entries({
    bRankScore: 52,
    aRankScore: 53,
    sRankScore: 54,
    ssRankScore: 55,
    rankPointReward: 86,
    characterExpReward: 87,
    manaReward: 88,
    poolExpReward: 89,
    element: 73,
})) {
    assert.match(converterSource, new RegExp(`"${field}"\\s*:\\s*int\\(.*quest\\[${index}\\]`))
}
assert.match(converterSource, /clear_reward_id\s*=\s*_optional_int\(quest\[6\]\)/)
assert.match(converterSource, /score_reward_group_id\s*=\s*_optional_int\(quest\[72\]\)/)

function flattenQuestRows(source) {
    const rows = []
    for (const [eventId, folders] of Object.entries(source)) {
        for (const [localQuestId, values] of Object.entries(folders)) {
            for (const row of values) rows.push({
                eventId: Number(eventId),
                localQuestId: Number(localQuestId),
                row,
            })
        }
    }
    return rows
}

function optionalNumber(value) {
    if (value === undefined || value === null || value === "" || value === "(None)") return undefined
    return Number(value)
}

const rawQuestRows = flattenQuestRows(rawQuests)
assert.equal(rawQuestRows.length, 123)
assert.equal(Object.keys(quests).length, 123)

for (const { eventId, localQuestId, row } of rawQuestRows) {
    const questId = String(row[0])
    const converted = quests[questId]
    assert.ok(converted, `缺少无限演武关卡 ${questId}`)
    assert.equal(converted.eventId, eventId)
    assert.equal(converted.folderId, optionalNumber(row[1]))
    assert.equal(converted.scoreAttackQuestId, localQuestId)
    assert.equal(converted.name, row[4])
    assert.equal(converted.bRankScore, Number(row[52]))
    assert.equal(converted.aRankScore, Number(row[53]))
    assert.equal(converted.sRankScore, Number(row[54]))
    assert.equal(converted.ssRankScore, Number(row[55]))
    assert.equal(converted.rankPointReward, Number(row[86]))
    assert.equal(converted.characterExpReward, Number(row[87]))
    assert.equal(converted.manaReward, Number(row[88]))
    assert.equal(converted.poolExpReward, Number(row[89]))
    assert.equal(converted.timeLimitMs, Math.round(Number(row[104]) * 1000 / 60))
    assert.equal(converted.element, Number(row[73]))
    assert.equal(converted.clearRewardId, optionalNumber(row[6]))
    assert.equal(converted.scoreRewardGroupId, optionalNumber(row[72]))
    assert.equal(converted.sPlusRewardId, undefined)
    assert.deepEqual(entryCosts[`27_${questId}`], { itemId: 0, itemCount: 0, stamina: 10 })
    assert.equal(entryCosts[`9_${questId}`], undefined)
}

let convertedBorderCount = 0
const currentRewardKinds = new Set()
for (const [rewardId, wrappers] of Object.entries(rawBorderRewards)) {
    const row = wrappers[0]
    const key = `${row[1]}_${row[2]}`
    const converted = borderRewards[key]?.find(value => value.id === Number(rewardId))
    assert.ok(converted, `缺少无限演武分数奖励行 ${rewardId}`)
    assert.equal(converted.eventId, Number(row[1]))
    assert.equal(converted.questId, Number(row[2]))
    assert.equal(converted.score, Number(row[4]))
    assert.equal(converted.reasonId, Number(row[5]))

    const expectedSlots = []
    for (let slot = 0; slot < 6; slot++) {
        const base = 6 + slot * 3
        const kind = optionalNumber(row[base])
        if (kind === undefined) continue
        currentRewardKinds.add(kind)
        const id = optionalNumber(row[base + 1])
        expectedSlots.push({
            kind,
            ...(id !== undefined ? { id } : {}),
            amount: Number(row[base + 2]),
        })
    }
    assert.deepEqual(converted.rewards, expectedSlots)
    convertedBorderCount++
}
assert.equal(convertedBorderCount, 11100)
assert.deepEqual([...currentRewardKinds].sort(), [0])
assert.equal(borderRewards["1_101"].find(value => value.id === 101075).rewards.length, 2)

console.log("score attack event data tests passed")
