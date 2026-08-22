"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const projectRoot = path.resolve(__dirname, "..")
const sourceRoot = path.join(projectRoot, "src")
const CALLEES = new Map([
    ["reconcileAwakeUnlockCharacterList", "default"],
    ["reconcileAwakeUnlockCharacterListStrict", "strict"],
])
const ROUTE_OWNERS = Object.freeze({
    "src/routes/api/activeMission.ts": { "/receive": "active_mission/receive" },
    "src/routes/api/boxGacha.ts": { "/exec": "box_gacha/exec" },
    "src/routes/api/character.ts": {
        "/add_character_from_town": "character/add_character_from_town",
    },
    "src/routes/api/character/bond.ts": {
        "/receive_bond_token": "character/receive_bond_token",
    },
    "src/routes/api/character/mana.ts": { "/learn_mana_node": "character/learn_mana_node" },
    "src/routes/api/exchange.ts": { "/star_crumb": "exchange/star_crumb" },
    "src/routes/api/gacha.ts": {
        "/exchange_character": "gacha/exchange_character",
        "/exec": "gacha/exec",
    },
    "src/routes/api/item.ts": { "/sell": "item/sell" },
    "src/routes/api/mail.ts": {
        "/receive": "mail/receive",
        "/receive_all": "mail/receive_all",
    },
    "src/routes/api/mission.ts": {
        "/update_mission_progress": "mission/update_mission_progress",
    },
    "src/routes/api/shop.ts": { "/buy": "shop/buy", "/bulk_buy": "shop/bulk_buy" },
    "src/routes/api/storyQuest.ts": { "/finish": "story_quest/finish" },
})

const EXPECTED_MATRIX = Object.freeze([
    {
        relativeFile: "src/lib/quest/finish/single-settlement-writes.ts",
        callee: "default",
        ownerLabel: "single/finish",
        boundary: "best-effort-in-tx",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "battle-party+direct-missions",
    },
    {
        relativeFile: "src/multi/settlement/orchestrator.ts",
        callee: "default",
        ownerLabel: "multi/finish",
        boundary: "best-effort-in-tx",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "battle-party+direct-missions",
    },
    {
        relativeFile: "src/routes/api/activeMission.ts",
        callee: "default",
        ownerLabel: "active_mission/receive",
        boundary: "best-effort-in-tx",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "claimed-reward-characters",
    },
    {
        relativeFile: "src/routes/api/boxGacha.ts",
        callee: "default",
        ownerLabel: "box_gacha/exec",
        boundary: "best-effort-post-commit",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "drawn-reward-characters",
    },
    {
        relativeFile: "src/routes/api/character.ts",
        callee: "default",
        ownerLabel: "character/add_character_from_town",
        boundary: "best-effort-post-commit",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "town-granted-character",
    },
    {
        relativeFile: "src/routes/api/character/bond.ts",
        callee: "default",
        ownerLabel: "character/receive_bond_token",
        boundary: "best-effort-in-tx",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "bond-character",
    },
    {
        relativeFile: "src/routes/api/character/mana.ts",
        callee: "strict",
        ownerLabel: "character/learn_mana_node",
        boundary: "strict-in-tx",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "target-character",
    },
    {
        relativeFile: "src/routes/api/exchange.ts",
        callee: "default",
        ownerLabel: "exchange/star_crumb",
        boundary: "best-effort-post-commit",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "exchange-reward-characters",
    },
    {
        relativeFile: "src/routes/api/gacha.ts",
        callee: "default",
        ownerLabel: "gacha/exchange_character",
        boundary: "best-effort-post-commit",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "exchanged-character",
    },
    {
        relativeFile: "src/routes/api/gacha.ts",
        callee: "default",
        ownerLabel: "gacha/exec",
        boundary: "best-effort-post-commit",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "drawn-characters",
    },
    {
        relativeFile: "src/routes/api/item.ts",
        callee: "default",
        ownerLabel: "item/sell",
        boundary: "best-effort-post-commit",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "mana-item-fact",
    },
    {
        relativeFile: "src/routes/api/mail.ts",
        callee: "default",
        ownerLabel: "mail/receive",
        boundary: "best-effort-in-tx",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "mail-reward-characters",
    },
    {
        relativeFile: "src/routes/api/mail.ts",
        callee: "default",
        ownerLabel: "mail/receive_all",
        boundary: "best-effort-in-tx",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "mail-reward-characters",
    },
    {
        relativeFile: "src/routes/api/mission.ts",
        callee: "default",
        ownerLabel: "mission/update_mission_progress",
        boundary: "best-effort-post-commit",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "category9-delta-missions",
    },
    {
        relativeFile: "src/routes/api/shop.ts",
        callee: "default",
        ownerLabel: "shop/buy",
        boundary: "best-effort-post-commit",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "shop-reward-characters",
    },
    {
        relativeFile: "src/routes/api/shop.ts",
        callee: "default",
        ownerLabel: "shop/bulk_buy",
        boundary: "best-effort-post-commit",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "shop-reward-characters",
    },
    {
        relativeFile: "src/routes/api/storyQuest.ts",
        callee: "default",
        ownerLabel: "story_quest/finish",
        boundary: "best-effort-in-tx",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "story-reward-characters",
    },
    {
        relativeFile: "src/routes/api/tutorial.ts",
        callee: "default",
        ownerLabel: "tutorial/update_step:15",
        boundary: "best-effort-in-tx",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "tutorial-gacha-characters",
    },
    {
        relativeFile: "src/routes/api/tutorial.ts",
        callee: "default",
        ownerLabel: "tutorial/update_step:16",
        boundary: "best-effort-in-tx",
        candidateSource: "legacy-unscoped",
        plannedCandidateSource: "tutorial-present-character",
    },
])

function calleeIdentifier(node) {
    return ts.isIdentifier(node.expression) ? node.expression.text : null
}

function isTransactionCallback(node) {
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false
    const call = node.parent
    if (!ts.isCallExpression(call) || !call.arguments.includes(node)) return false
    const expression = call.expression
    return ts.isPropertyAccessExpression(expression) && expression.name.text === "transaction"
}

function isInsideDirectTransaction(call) {
    for (let parent = call.parent; parent; parent = parent.parent) {
        if (isTransactionCallback(parent)) return true
    }
    return false
}

function findRoutePath(call) {
    for (let parent = call.parent; parent; parent = parent.parent) {
        if (!ts.isCallExpression(parent)
            || !ts.isPropertyAccessExpression(parent.expression)
            || parent.expression.name.text !== "post"
            || !ts.isStringLiteral(parent.arguments[0])) continue
        return parent.arguments[0].text
    }
    return null
}

function findEnclosingFunctionName(call) {
    for (let parent = call.parent; parent; parent = parent.parent) {
        if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text
        if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent))
            && ts.isVariableDeclaration(parent.parent)
            && ts.isIdentifier(parent.parent.name)) return parent.parent.name.text
    }
    return null
}

function classifyOwner(relativeFile, call, sourceFile) {
    if (relativeFile === "src/lib/quest/finish/single-settlement-writes.ts") {
        assert.equal(findEnclosingFunctionName(call), "executeSingleSettlementWrites")
        return "single/finish"
    }
    if (relativeFile === "src/multi/settlement/orchestrator.ts") {
        assert.equal(findEnclosingFunctionName(call), "executeFinishWrites")
        return "multi/finish"
    }
    if (relativeFile === "src/routes/api/storyQuest.ts") {
        assert.equal(findEnclosingFunctionName(call), "processStoryQuestFinish")
        return "story_quest/finish"
    }
    if (relativeFile === "src/routes/api/tutorial.ts") {
        assert.equal(findRoutePath(call), "/update_step")
        for (let parent = call.parent; parent; parent = parent.parent) {
            if (!ts.isIfStatement(parent)) continue
            const condition = parent.expression.getText(sourceFile)
            if (condition.includes("TUTORIAL_GACHA_EFFECTIVE_STEP")) {
                return "tutorial/update_step:15"
            }
            if (condition.includes("TUTORIAL_PRESENT_EFFECTIVE_STEP")) {
                return "tutorial/update_step:16"
            }
        }
        assert.fail("tutorial Awake publication left its audited step branch")
    }
    const routePath = findRoutePath(call)
    const ownerLabel = ROUTE_OWNERS[relativeFile]?.[routePath]
    assert.notEqual(ownerLabel, undefined, `${relativeFile}:${routePath} is not an audited owner`)
    return ownerLabel
}

function assertImportedProductionCallee(sourceFile, calleeName) {
    let found = false
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || !statement.moduleSpecifier.text.includes("mission")) continue
        const bindings = statement.importClause?.namedBindings
        if (!bindings || !ts.isNamedImports(bindings)) continue
        if (bindings.elements.some(element => element.name.text === calleeName)) found = true
    }
    assert.equal(found, true, `${sourceFile.fileName} must import ${calleeName} from mission code`)
}

function classifyBoundary(relativeFile, callee, call, source) {
    if (relativeFile === "src/lib/quest/finish/single-settlement-writes.ts") {
        const ownerSource = fs.readFileSync(
            path.join(projectRoot, "src/lib/quest/finish/single-orchestrator.ts"),
            "utf8",
        )
        assert.match(ownerSource, /runSingleFinishSettlementTransaction\([\s\S]*executeSingleSettlementWrites\(/)
        return "best-effort-in-tx"
    }
    if (relativeFile === "src/multi/settlement/orchestrator.ts") {
        assert.match(source, /runMultiActiveQuestSettlementTransaction\([\s\S]*executeFinishWrites,/)
        return "best-effort-in-tx"
    }
    const inTransaction = isInsideDirectTransaction(call)
    if (callee === "strict") {
        assert.equal(inTransaction, true, `${relativeFile} strict publication left its transaction`)
        return "strict-in-tx"
    }
    return inTransaction ? "best-effort-in-tx" : "best-effort-post-commit"
}

function collectProductionCalls() {
    const files = ts.sys.readDirectory(sourceRoot, [".ts"], undefined, undefined)
    const calls = []
    for (const file of files) {
        const relativeFile = path.relative(projectRoot, file).split(path.sep).join("/")
        if (relativeFile === "src/lib/mission/awake-unlock-response.ts") continue
        const source = fs.readFileSync(file, "utf8")
        const sourceFile = ts.createSourceFile(
            relativeFile,
            source,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        )
        function visit(node) {
            if (ts.isCallExpression(node)) {
                const identifier = calleeIdentifier(node)
                const callee = CALLEES.get(identifier)
                if (callee !== undefined) {
                    assertImportedProductionCallee(sourceFile, identifier)
                    assert.equal(
                        node.arguments.length,
                        2,
                        `${relativeFile} publication no longer uses the legacy-unscoped signature`,
                    )
                    calls.push({
                        relativeFile,
                        callee,
                        ownerLabel: classifyOwner(relativeFile, node, sourceFile),
                        boundary: classifyBoundary(relativeFile, callee, node, source),
                        candidateSource: "legacy-unscoped",
                        position: node.getStart(sourceFile),
                    })
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)
    }
    return calls.sort((left, right) => (
        left.relativeFile.localeCompare(right.relativeFile) || left.position - right.position
    ))
}

test("Awake reconcile production call expressions match the fixed 19-entry audit matrix", () => {
    const calls = collectProductionCalls()
    assert.equal(calls.length, 19)
    assert.deepEqual(
        calls.map(({ relativeFile, callee, ownerLabel, boundary, candidateSource }) => ({
            relativeFile,
            callee,
            ownerLabel,
            boundary,
            candidateSource,
        })),
        EXPECTED_MATRIX.map(({ relativeFile, callee, ownerLabel, boundary, candidateSource }) => ({
            relativeFile,
            callee,
            ownerLabel,
            boundary,
            candidateSource,
        })),
    )
    assert.equal(new Set(calls.map(call => `${call.relativeFile}:${call.position}`)).size, 19)
})

test("Awake reconcile audit matrix freezes owner, policy, and planned candidate source", () => {
    assert.equal(EXPECTED_MATRIX.length, 19)
    assert.deepEqual(
        Object.fromEntries(["strict-in-tx", "best-effort-in-tx", "best-effort-post-commit"]
            .map(boundary => [
                boundary,
                EXPECTED_MATRIX.filter(entry => entry.boundary === boundary).length,
            ])),
        {
            "strict-in-tx": 1,
            "best-effort-in-tx": 9,
            "best-effort-post-commit": 9,
        },
    )
    assert.equal(new Set(EXPECTED_MATRIX.map(entry => entry.ownerLabel)).size, 19)
    for (const entry of EXPECTED_MATRIX) {
        assert.equal(entry.candidateSource, "legacy-unscoped")
        assert.match(entry.plannedCandidateSource, /^[a-z0-9+:-]+$/)
    }
    for (const pair of [
        ["single/finish", "multi/finish"],
        ["mail/receive", "mail/receive_all"],
        ["tutorial/update_step:15", "tutorial/update_step:16"],
        ["shop/buy", "shop/bulk_buy"],
        ["gacha/exchange_character", "gacha/exec"],
    ]) {
        assert.equal(pair.every(owner => EXPECTED_MATRIX.some(entry => entry.ownerLabel === owner)), true)
    }
})
