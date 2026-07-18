const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const routePath = path.join(__dirname, "..", "src", "routes", "api", "singleBattleQuest.ts");
const routeSource = fs.readFileSync(routePath, "utf8");

test("single battle keeps release mode behavior and records mission dimensions", () => {
    assert.ok(
        /const\s+prerequisiteCheck\s*=\s*canStartQuestByPrerequisites\s*\(/.test(routeSource)
            && /if\s*\(\s*!prerequisiteCheck\.ok\s*\)/.test(routeSource),
        "Advent prerequisite enforcement must survive the main merge",
    );
    assert.ok(
        /const\s+rogueDrops\s*=\s*handleRoguePerRoundDrops\s*\(\s*\{/.test(routeSource)
            && /rushEventData\.rush_battle_reward_list\s*=\s*\[[\s\S]*?\.\.\.rogueDrops\.rewardListEntries[\s\S]*?\]/.test(routeSource),
        "Rogue per-round drops must survive the main merge",
    );
    assert.ok(
        /recordBattleMissionDimensionsSafe\s*\(\s*\{/.test(routeSource),
        "battle completion must call the fail-open mission-dimension writer",
    );
});
