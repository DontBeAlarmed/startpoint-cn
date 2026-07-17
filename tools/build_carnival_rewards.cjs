const fs = require("node:fs")
const path = require("node:path")
require("ts-node/register/transpile-only")

const {
    CARNIVAL_REWARD_KINDS,
    parseCarnivalRewardRow,
} = require("../src/lib/carnival-reward-parser")

const projectRoot = path.resolve(__dirname, "..")
const inputPath = path.resolve(
    projectRoot,
    "../wf-assets-cn/orderedmap/quest/event/carnival_event_total_score_reward.json",
)
const outputPath = path.resolve(projectRoot, "assets/carnival_event_total_score_reward.json")

if (!fs.existsSync(inputPath)) {
    throw new Error(`CN Carnival reward source not found: ${inputPath}`)
}

const source = JSON.parse(fs.readFileSync(inputPath, "utf8"))
const output = {}
const eventIds = new Set()

for (const [rewardId, rows] of Object.entries(source)) {
    if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0])) {
        throw new Error(`Carnival reward ${rewardId} has an invalid row container`)
    }
    const definition = parseCarnivalRewardRow(Number(rewardId), rows[0])
    output[rewardId] = definition
    eventIds.add(definition.eventId)
    for (const reward of definition.rewards) {
        if (!CARNIVAL_REWARD_KINDS.has(reward.kind)) {
            throw new Error(`Carnival reward ${rewardId} has unsupported kind ${reward.kind}`)
        }
    }
}

if (Object.keys(output).length !== 1451) {
    throw new Error(`Expected 1451 Carnival rewards, got ${Object.keys(output).length}`)
}
if (eventIds.size !== 19) throw new Error(`Expected 19 Carnival events, got ${eventIds.size}`)

fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`)
console.log(`Generated ${Object.keys(output).length} Carnival rewards for ${eventIds.size} events`)
