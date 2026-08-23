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
    ["reconcileAwakeUnlockCharacterListBestEffort", "best-effort"],
])
const AWAKE_CALLEE_PREFIX = "reconcileAwakeUnlockCharacterList"
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

function isMissionModuleSpecifier(specifier) {
    return /(?:^|\/)mission(?:\/|$)/.test(specifier)
}

function collectImportedAwakeCalls(source, fileName) {
    const sourceFile = ts.createSourceFile(
        fileName,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    )
    const namedImports = new Map()
    const namespaceImports = new Set()

    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || !isMissionModuleSpecifier(statement.moduleSpecifier.text)) continue
        const bindings = statement.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
                const exportedName = element.propertyName?.text ?? element.name.text
                if (exportedName.startsWith(AWAKE_CALLEE_PREFIX)) {
                    namedImports.set(element.name.text, exportedName)
                }
            }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
            namespaceImports.add(bindings.name.text)
        }
    }

    const calls = []
    function visit(node) {
        if (ts.isCallExpression(node)) {
            let exportedName = null
            if (ts.isIdentifier(node.expression)) {
                exportedName = namedImports.get(node.expression.text) ?? null
            } else if (ts.isPropertyAccessExpression(node.expression)
                && ts.isIdentifier(node.expression.expression)
                && namespaceImports.has(node.expression.expression.text)
                && node.expression.name.text.startsWith(AWAKE_CALLEE_PREFIX)) {
                exportedName = node.expression.name.text
            }
            if (exportedName !== null) {
                const callee = CALLEES.get(exportedName)
                if (callee === undefined) {
                    throw new Error(`${fileName} calls unknown Awake publication helper ${exportedName}`)
                }
                calls.push({ callee, call: node, exportedName, sourceFile })
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return calls
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

function collectIdentifierCalls(root, calleeName) {
    const calls = []
    function visit(node) {
        if (ts.isCallExpression(node)
            && ts.isIdentifier(node.expression)
            && node.expression.text === calleeName) calls.push(node)
        ts.forEachChild(node, visit)
    }
    visit(root)
    return calls
}

function assertSingleSettlementTransactionOwnership(source, fileName) {
    const sourceFile = ts.createSourceFile(
        fileName,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    )
    const transactionCalls = collectIdentifierCalls(
        sourceFile,
        "runSingleFinishSettlementTransaction",
    )
    assert.equal(
        transactionCalls.length,
        1,
        `${fileName} must contain exactly one runSingleFinishSettlementTransaction call`,
    )
    const options = transactionCalls[0].arguments[0]
    assert.equal(
        options !== undefined && ts.isObjectLiteralExpression(options),
        true,
        `${fileName} transaction must receive an object argument`,
    )
    const settleProperties = options.properties.filter(property => (
        ts.isPropertyAssignment(property)
        && ((ts.isIdentifier(property.name) && property.name.text === "settle")
            || (ts.isStringLiteral(property.name) && property.name.text === "settle"))
    ))
    assert.equal(
        settleProperties.length,
        1,
        `${fileName} transaction must define one settle callback`,
    )
    const settleCallback = settleProperties[0].initializer
    assert.equal(
        ts.isArrowFunction(settleCallback) || ts.isFunctionExpression(settleCallback),
        true,
        `${fileName} settle must be an inline callback`,
    )
    assert.equal(
        collectIdentifierCalls(settleCallback, "executeSingleSettlementWrites").length > 0,
        true,
        `${fileName} settle callback must contain executeSingleSettlementWrites`,
    )
}

function assertMultiSettlementTransactionOwnership(sourceFile, awakeCall) {
    let executeDeclaration = null
    for (let parent = awakeCall.parent; parent; parent = parent.parent) {
        if (ts.isVariableDeclaration(parent)
            && ts.isIdentifier(parent.name)
            && parent.name.text === "executeFinishWrites"
            && parent.initializer
            && (ts.isArrowFunction(parent.initializer)
                || ts.isFunctionExpression(parent.initializer))) {
            executeDeclaration = parent
            break
        }
    }
    assert.notEqual(
        executeDeclaration,
        null,
        `${sourceFile.fileName} Awake call must belong to the executeFinishWrites initializer`,
    )
    const transactionCalls = collectIdentifierCalls(
        sourceFile,
        "runMultiActiveQuestSettlementTransaction",
    )
    assert.equal(
        transactionCalls.length,
        1,
        `${sourceFile.fileName} must contain exactly one runMultiActiveQuestSettlementTransaction call`,
    )
    const writesArgument = transactionCalls[0].arguments[2]
    assert.equal(
        writesArgument !== undefined
            && ts.isIdentifier(writesArgument)
            && writesArgument.text === "executeFinishWrites",
        true,
        `${sourceFile.fileName} transaction third argument must reference executeFinishWrites`,
    )
}

function classifyBoundary(relativeFile, callee, call) {
    if (relativeFile === "src/lib/quest/finish/single-settlement-writes.ts") {
        const ownerSource = fs.readFileSync(
            path.join(projectRoot, "src/lib/quest/finish/single-orchestrator.ts"),
            "utf8",
        )
        assertSingleSettlementTransactionOwnership(
            ownerSource,
            "src/lib/quest/finish/single-orchestrator.ts",
        )
        return "best-effort-in-tx"
    }
    if (relativeFile === "src/multi/settlement/orchestrator.ts") {
        assertMultiSettlementTransactionOwnership(call.getSourceFile(), call)
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
        for (const importedCall of collectImportedAwakeCalls(source, relativeFile)) {
            const { call, callee, sourceFile } = importedCall
            assert.equal(
                call.arguments.length,
                2,
                `${relativeFile} publication no longer uses the legacy-unscoped signature`,
            )
            calls.push({
                relativeFile,
                callee,
                ownerLabel: classifyOwner(relativeFile, call, sourceFile),
                boundary: classifyBoundary(relativeFile, callee, call),
                candidateSource: "legacy-unscoped",
                position: call.getStart(sourceFile),
            })
        }
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

test("AST collector resolves explicit BestEffort, named aliases, and namespace helpers", () => {
    const source = `
        import {
            reconcileAwakeUnlockCharacterListBestEffort,
            reconcileAwakeUnlockCharacterList as publishDefault,
        } from "./mission"
        import * as missionApi from "./mission/index"

        reconcileAwakeUnlockCharacterListBestEffort(1, [])
        publishDefault(1, [])
        missionApi.reconcileAwakeUnlockCharacterList(1, [])
        missionApi.reconcileAwakeUnlockCharacterListStrict(1, [])
        missionApi.reconcileAwakeUnlockCharacterListBestEffort(1, [])
    `

    const calls = collectImportedAwakeCalls(source, "synthetic.ts")

    assert.deepEqual(calls.map(call => ({
        callee: call.callee,
        exportedName: call.exportedName,
    })), [
        {
            callee: "best-effort",
            exportedName: "reconcileAwakeUnlockCharacterListBestEffort",
        },
        {
            callee: "default",
            exportedName: "reconcileAwakeUnlockCharacterList",
        },
        {
            callee: "default",
            exportedName: "reconcileAwakeUnlockCharacterList",
        },
        {
            callee: "strict",
            exportedName: "reconcileAwakeUnlockCharacterListStrict",
        },
        {
            callee: "best-effort",
            exportedName: "reconcileAwakeUnlockCharacterListBestEffort",
        },
    ])
})

test("AST collector fails closed on unknown imported Awake publication suffixes", () => {
    for (const source of [
        `
            import { reconcileAwakeUnlockCharacterListUnexpected } from "./mission"
            reconcileAwakeUnlockCharacterListUnexpected(1, [])
        `,
        `
            import * as missionApi from "./mission"
            missionApi.reconcileAwakeUnlockCharacterListUnexpected(1, [])
        `,
    ]) {
        assert.throws(
            () => collectImportedAwakeCalls(source, "synthetic.ts"),
            /unknown Awake publication helper/,
        )
    }
})

test("AST collector ignores ordinary local functions with an Awake helper-like name", () => {
    const source = `
        function reconcileAwakeUnlockCharacterList() { return [] }
        reconcileAwakeUnlockCharacterList(1, [])
    `

    assert.deepEqual(collectImportedAwakeCalls(source, "synthetic.ts"), [])
})

test("single settlement ownership requires writes inside the settle callback", () => {
    const owned = `
        runSingleFinishSettlementTransaction({
            settle: () => executeSingleSettlementWrites({}),
        })
    `
    const movedOutside = `
        executeSingleSettlementWrites({})
        runSingleFinishSettlementTransaction({ settle: () => ({}) })
    `

    assert.doesNotThrow(() => assertSingleSettlementTransactionOwnership(owned, "single.ts"))
    assert.throws(
        () => assertSingleSettlementTransactionOwnership(movedOutside, "single.ts"),
        /settle callback.*executeSingleSettlementWrites/i,
    )
})

test("multi settlement ownership requires executeFinishWrites as the third argument", () => {
    const owned = `
        import { reconcileAwakeUnlockCharacterList } from "./mission"
        const executeFinishWrites = () => reconcileAwakeUnlockCharacterList(1, [])
        const otherWrites = () => true
        runMultiActiveQuestSettlementTransaction(1, {}, executeFinishWrites)
    `
    const replaced = owned.replace(
        "runMultiActiveQuestSettlementTransaction(1, {}, executeFinishWrites)",
        "runMultiActiveQuestSettlementTransaction(1, {}, otherWrites)",
    )

    for (const [source, expectedFailure] of [[owned, false], [replaced, true]]) {
        const [awakeCall] = collectImportedAwakeCalls(source, "multi.ts")
        const assertion = () => assertMultiSettlementTransactionOwnership(
            awakeCall.sourceFile,
            awakeCall.call,
        )
        if (expectedFailure) assert.throws(assertion, /third argument.*executeFinishWrites/i)
        else assert.doesNotThrow(assertion)
    }
})
