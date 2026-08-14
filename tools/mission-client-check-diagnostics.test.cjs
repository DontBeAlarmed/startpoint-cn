require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { formatHardMultiMissionDiagnostic } = require("../src/lib/mission/client-check-diagnostics")

assert.equal(
    formatHardMultiMissionDiagnostic({
        category: 26,
        questId: 1006001,
        accomplished: true,
        clearRank: 5,
        clearTimeMs: 26537,
        statistics: {
            client_checks: ["hard_multi_steam_robot_dark"],
        },
    }),
    '[MISSION] hard_multi_finish category=26 quest=1006001 accomplished=true clearRank=5 clearTimeMs=26537 client_checks=["hard_multi_steam_robot_dark"]',
)

assert.equal(
    formatHardMultiMissionDiagnostic({
        category: 26,
        questId: 1006001,
        accomplished: true,
        clearRank: 5,
        clearTimeMs: 26537,
        statistics: {},
    }),
    '[MISSION] hard_multi_finish category=26 quest=1006001 accomplished=true clearRank=5 clearTimeMs=26537 client_checks=<missing>',
)

assert.equal(
    formatHardMultiMissionDiagnostic({
        category: 26,
        questId: 1006001,
        accomplished: true,
        clearRank: 5,
        clearTimeMs: 26537,
        statistics: { client_checks: { value: "hard_multi_steam_robot_dark" } },
    }),
    '[MISSION] hard_multi_finish category=26 quest=1006001 accomplished=true clearRank=5 clearTimeMs=26537 client_checks=<object>',
)

assert.equal(
    formatHardMultiMissionDiagnostic({
        category: 1,
        questId: 1001,
        accomplished: true,
        clearRank: 5,
        clearTimeMs: 1000,
        statistics: { client_checks: ["ignored"] },
    }),
    null,
)

const battleSource = fs.readFileSync(path.join(__dirname, "../src/multi/http/battle.ts"), "utf8")
assert.match(
    battleSource,
    /if \(questCategory === 26\) \{\s*sampledLog\("hard-multi-mission-diagnostic", \(\) =>\s*formatHardMultiMissionDiagnostic\(/,
    "category 26 should be checked before sampling and diagnostic formatting should stay inside the factory",
)

console.log("mission client-check diagnostics tests passed")
