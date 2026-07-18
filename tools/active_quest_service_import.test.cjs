const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const servicePath = require.resolve("../src/lib/quest/active-quest-service")
const singleRoutePath = require.resolve("../src/routes/api/singleBattleQuest")
const loadRoutePath = require.resolve("../src/routes/cn/load")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

stubModule("../src/data/db", {
    getDb: () => ({ transaction: operation => operation }),
})
stubModule("../src/data/domains/quest_active", {
    deletePlayerActiveQuestSync() {},
    getPlayerActiveQuestSync() { return null },
    insertPlayerActiveQuestSync() {},
})
stubModule("../src/data/domains/item", {
    getPlayerItemSync() { return null },
    setPlayerItemSync() {},
})

delete require.cache[servicePath]
delete require.cache[singleRoutePath]
delete require.cache[loadRoutePath]

const service = require(servicePath)
assert.equal(typeof service.insertActiveQuest, "function")
assert.equal(typeof service.runAbortActiveQuestTransaction, "function")
assert.ok(service.activeQuests && typeof service.activeQuests === "object")
assert.equal(require.cache[singleRoutePath], undefined)
assert.equal(require.cache[loadRoutePath], undefined)

const imports = {
    "src/routes/api/singleBattleQuest.ts": "../../lib/quest/active-quest-service",
    "src/routes/cn/load.ts": "../../lib/quest/active-quest-service",
    "src/multi/http/battle.ts": "../../lib/quest/active-quest-service",
    "src/routes/api/raidEvent.ts": "../../lib/quest/active-quest-service",
    "src/routes/api/rushEvent.ts": "../../lib/quest/active-quest-service",
}

for (const [relativePath, expectedImport] of Object.entries(imports)) {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
    assert.match(source, new RegExp(expectedImport.replaceAll("/", "\\/")))
}

const loadSource = fs.readFileSync(path.join(projectRoot, "src/routes/cn/load.ts"), "utf8")
assert.doesNotMatch(loadSource, /routes\/api\/singleBattleQuest|\.\.\/api\/singleBattleQuest/)

const rushSource = fs.readFileSync(path.join(projectRoot, "src/routes/api/rushEvent.ts"), "utf8")
assert.match(rushSource, /import\s+type\s+\{\s*FinishBody\s*\}\s+from\s+["']\.\/singleBattleQuest["']/)
assert.doesNotMatch(rushSource, /import\s+\{[^}]*FinishBody[^}]*\}\s+from\s+["']\.\/singleBattleQuest["']/)

console.log("active quest service import tests passed")
