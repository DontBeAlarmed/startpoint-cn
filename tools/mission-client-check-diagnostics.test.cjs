require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
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

console.log("mission client-check diagnostics tests passed")
