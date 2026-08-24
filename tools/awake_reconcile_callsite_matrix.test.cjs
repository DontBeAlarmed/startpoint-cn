"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")
const {
    AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY,
    AWAKE_OWNER_SQL_UPPER_BOUND_REGISTRY,
    SINGLE_REREAD_REASON,
} = require("./perf/awake_owner_focused_scenarios.cjs")
const OWNER_FOCUSED_SNAPSHOT = require(
    "./perf/__snapshots__/awake_owner_focused_baseline.json"
)

const projectRoot = path.resolve(__dirname, "..")
const sourceRoot = path.join(projectRoot, "src")
const CALLEES = new Map([
    ["reconcileAwakeUnlockCharacterList", "default"],
    ["reconcileAwakeUnlockCharacterListStrict", "strict"],
    ["reconcileAwakeUnlockCharacterListBestEffort", "best-effort"],
    ["publishAwakeCharacterListBestEffort", "best-effort"],
])
const AWAKE_CALLEE_PREFIX = "reconcileAwakeUnlockCharacterList"
const SINGLE_AWAKE_WRAPPER = "publishAwakeCharacterListBestEffort"
const PLANNED_CANDIDATE_SOURCES = Object.freeze({
    "single/finish": "battle-party+direct-missions",
    "multi/finish": "battle-party+direct-missions",
    "active_mission/receive": "claimed-reward-characters",
    "box_gacha/exec": "drawn-reward-characters",
    "character/add_character_from_town": "town-granted-character",
    "character/receive_bond_token": "bond-character",
    "character/learn_mana_node": "target-character",
    "exchange/star_crumb": "exchange-reward-characters",
    "gacha/exchange_character": "exchanged-character",
    "gacha/exec": "drawn-characters",
    "item/sell": "mana-item-fact",
    "mail/receive": "mail-reward-characters",
    "mail/receive_all": "mail-reward-characters",
    "mission/update_mission_progress": "category9-delta-missions",
    "shop/buy": "shop-reward-characters",
    "shop/bulk_buy": "shop-reward-characters",
    "story_quest/finish": "story-reward-characters",
    "tutorial/update_step:15": "tutorial-gacha-characters",
    "tutorial/update_step:16": "tutorial-present-character",
    "pass_card/receive_all": "pass-card-reward-facts",
    "raid_event/summary": "raid-summary-reward-facts",
})
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
    "src/routes/api/passCard.ts": { "/receive_all": "pass_card/receive_all" },
    "src/routes/api/raidEvent.ts": { "/summary": "raid_event/summary" },
    "src/routes/api/shop.ts": { "/buy": "shop/buy", "/bulk_buy": "shop/bulk_buy" },
    "src/routes/api/storyQuest.ts": { "/finish": "story_quest/finish" },
})

const REQUIRED_OWNER_EVIDENCE_FIELDS = Object.freeze([
    "owner",
    "boundary",
    "actualCharacterSeed",
    "actualFactSeeds",
    "directMissionSeed",
    "finalAuthoritativeWrite",
    "snapshotSource",
    "rereadReason",
    "sqlUpperBoundKey",
    "runtimeEvidenceKey",
])
const GLOBAL_FACT_OWNERS = new Set([
    "single/finish",
    "multi/finish",
    "active_mission/receive",
    "box_gacha/exec",
    "item/sell",
    "mail/receive",
    "mail/receive_all",
    "pass_card/receive_all",
    "raid_event/summary",
    "shop/buy",
    "shop/bulk_buy",
    "story_quest/finish",
])

const DEFAULT_REREAD_REASON = "no owner snapshot is injected; bounded facts are reread after the final authoritative write"

function matrixRow({
    relativeFile,
    callee = "best-effort",
    owner,
    boundary,
    actualCharacterSeed,
    actualFactSeeds = "none",
    directMissionSeed = "none",
    finalAuthoritativeWrite,
    runtimeEvidenceKey,
    changesGlobalFacts = false,
    rereadReason = DEFAULT_REREAD_REASON,
}) {
    return Object.freeze({
        relativeFile,
        callee,
        owner,
        ownerLabel: owner,
        boundary,
        candidateSource: "scoped-context",
        plannedCandidateSource: PLANNED_CANDIDATE_SOURCES[owner],
        actualCharacterSeed,
        actualFactSeeds,
        directMissionSeed,
        finalAuthoritativeWrite,
        snapshotSource: "none",
        rereadReason,
        sqlUpperBoundKey: runtimeEvidenceKey,
        runtimeEvidenceKey,
        changesGlobalFacts,
    })
}

const EXPECTED_MATRIX = Object.freeze([
    matrixRow({ relativeFile: "src/lib/quest/finish/single-settlement-writes.ts", owner: "single/finish", boundary: "best-effort-in-tx", actualCharacterSeed: "partyCharacterIds", actualFactSeeds: "invalidatedFactKeys", finalAuthoritativeWrite: "deletePlayerActiveQuestSync", runtimeEvidenceKey: "single-finish", changesGlobalFacts: true, rereadReason: SINGLE_REREAD_REASON }),
    matrixRow({ relativeFile: "src/multi/settlement/orchestrator.ts", owner: "multi/finish", boundary: "best-effort-in-tx", actualCharacterSeed: "candidateCharacterIds", actualFactSeeds: "invalidatedFactKeys", finalAuthoritativeWrite: "deleteActiveQuest", runtimeEvidenceKey: "multi-finish", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/activeMission.ts", owner: "active_mission/receive", boundary: "best-effort-in-tx", actualCharacterSeed: "candidateCharacterIds", actualFactSeeds: "granter.invalidatedFactKeys", finalAuthoritativeWrite: "persistPlayer", runtimeEvidenceKey: "active-mission-receive", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/boxGacha.ts", owner: "box_gacha/exec", boundary: "best-effort-post-commit", actualCharacterSeed: "settlement.rewardResult?.joined_character_id_list ?? []", actualFactSeeds: "reward-result", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "box-gacha-exec", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/character.ts", owner: "character/add_character_from_town", boundary: "best-effort-post-commit", actualCharacterSeed: "[characterId]", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "character-town-grant" }),
    matrixRow({ relativeFile: "src/routes/api/character/bond.ts", owner: "character/receive_bond_token", boundary: "best-effort-in-tx", actualCharacterSeed: "candidateCharacterIds", finalAuthoritativeWrite: "updatePlayerCharacterBondTokenSync", runtimeEvidenceKey: "bond-success" }),
    matrixRow({ relativeFile: "src/routes/api/character/mana.ts", callee: "strict", owner: "character/learn_mana_node", boundary: "strict-in-tx", actualCharacterSeed: "[characterId]", finalAuthoritativeWrite: "updatePlayerCharacterSync", runtimeEvidenceKey: "learn-mana-final-node" }),
    matrixRow({ relativeFile: "src/routes/api/exchange.ts", owner: "exchange/star_crumb", boundary: "best-effort-post-commit", actualCharacterSeed: "kind === 0 ? [targetId] : []", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "exchange-star-crumb" }),
    matrixRow({ relativeFile: "src/routes/api/gacha.ts", owner: "gacha/exchange_character", boundary: "best-effort-post-commit", actualCharacterSeed: "[characterId]", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "gacha-exchange-character" }),
    matrixRow({ relativeFile: "src/routes/api/gacha.ts", owner: "gacha/exec", boundary: "best-effort-post-commit", actualCharacterSeed: "[]", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "gacha-exec" }),
    matrixRow({ relativeFile: "src/routes/api/item.ts", owner: "item/sell", boundary: "best-effort-post-commit", actualCharacterSeed: "[]", actualFactSeeds: "player", finalAuthoritativeWrite: "sellItemSync", runtimeEvidenceKey: "mana-item-sell", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/mail.ts", owner: "mail/receive", boundary: "best-effort-in-tx", actualCharacterSeed: "candidateCharacterIds", actualFactSeeds: "mail", finalAuthoritativeWrite: "receiveMailSync", runtimeEvidenceKey: "mail-receive", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/mail.ts", owner: "mail/receive_all", boundary: "best-effort-in-tx", actualCharacterSeed: "candidateCharacterIds", actualFactSeeds: "mail", finalAuthoritativeWrite: "receiveMailSync", runtimeEvidenceKey: "mail-receive-all", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/mission.ts", owner: "mission/update_mission_progress", boundary: "best-effort-post-commit", actualCharacterSeed: "awakeCandidateCharacterIds", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "category9-update-progress" }),
    matrixRow({ relativeFile: "src/routes/api/passCard.ts", owner: "pass_card/receive_all", boundary: "best-effort-post-commit", actualCharacterSeed: "[]", actualFactSeeds: "result.invalidatedFactKeys", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "pass-card-receive-all", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/raidEvent.ts", owner: "raid_event/summary", boundary: "best-effort-post-commit", actualCharacterSeed: "[]", actualFactSeeds: "reward-result", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "raid-event-summary", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/shop.ts", owner: "shop/buy", boundary: "best-effort-post-commit", actualCharacterSeed: "rewardResult.joined_character_id_list ?? []", actualFactSeeds: "reward-result", finalAuthoritativeWrite: "executeGenericShopPurchaseSync", runtimeEvidenceKey: "shop-buy", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/shop.ts", owner: "shop/bulk_buy", boundary: "best-effort-post-commit", actualCharacterSeed: "rewardResult.joined_character_id_list ?? []", actualFactSeeds: "reward-result", finalAuthoritativeWrite: "executeGenericShopBatchPurchaseSync", runtimeEvidenceKey: "shop-bulk-buy", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/storyQuest.ts", owner: "story_quest/finish", boundary: "best-effort-in-tx", actualCharacterSeed: "candidateCharacterIds", actualFactSeeds: "story-reward+quest-progress", finalAuthoritativeWrite: "reconcileActiveMissionFacts", runtimeEvidenceKey: "story-finish", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/tutorial.ts", owner: "tutorial/update_step:15", boundary: "best-effort-in-tx", actualCharacterSeed: "candidateCharacterIds", finalAuthoritativeWrite: "updatePlayerSync", runtimeEvidenceKey: "tutorial-step-15" }),
    matrixRow({ relativeFile: "src/routes/api/tutorial.ts", owner: "tutorial/update_step:16", boundary: "best-effort-in-tx", actualCharacterSeed: "candidateCharacterIds", finalAuthoritativeWrite: "updatePlayerSync", runtimeEvidenceKey: "tutorial-step-16" }),
])

function isMissionModuleSpecifier(specifier) {
    return /(?:^|\/)mission(?:\/|$)/.test(specifier)
}

function collectImportedAwakeCalls(source, fileName) {
    const { checker, sourceFile } = createTypeCheckedSource(source, fileName)
    const namedImports = []
    const namespaceImports = []

    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)
            || !ts.isStringLiteral(statement.moduleSpecifier)) continue
        const moduleSpecifier = statement.moduleSpecifier.text
        const bindings = statement.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
                const exportedName = element.propertyName?.text ?? element.name.text
                if (!exportedName.startsWith(AWAKE_CALLEE_PREFIX)
                    && exportedName !== SINGLE_AWAKE_WRAPPER) continue
                const symbol = checker.getSymbolAtLocation(element.name)
                if (symbol === undefined) continue
                namedImports.push({ symbol, exportedName, moduleSpecifier })
            }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
            const symbol = checker.getSymbolAtLocation(bindings.name)
            if (symbol !== undefined) namespaceImports.push({ symbol, moduleSpecifier })
        }
    }

    const calls = []
    function visit(node) {
        if (ts.isCallExpression(node)) {
            let exportedName = null
            let moduleSpecifier = null
            if (ts.isIdentifier(node.expression)) {
                const symbol = checker.getSymbolAtLocation(node.expression)
                const imported = namedImports.find(entry => entry.symbol === symbol)
                exportedName = imported?.exportedName ?? null
                moduleSpecifier = imported?.moduleSpecifier ?? null
            } else if (ts.isPropertyAccessExpression(node.expression)
                && ts.isIdentifier(node.expression.expression)
            ) {
                const namespaceSymbol = checker.getSymbolAtLocation(node.expression.expression)
                const imported = namespaceImports.find(entry => entry.symbol === namespaceSymbol)
                if (imported === undefined) {
                    ts.forEachChild(node, visit)
                    return
                }
                const namespaceSpecifier = imported.moduleSpecifier
                const name = node.expression.name.text
                if (name.startsWith(AWAKE_CALLEE_PREFIX) || name === SINGLE_AWAKE_WRAPPER) {
                    exportedName = name
                    moduleSpecifier = namespaceSpecifier
                }
            }
            if (exportedName !== null) {
                if (exportedName === SINGLE_AWAKE_WRAPPER
                    && !moduleSpecifier.endsWith("/awake-best-effort-context")) {
                    throw new Error(`${fileName} single Awake wrapper import must use awake-best-effort-context`)
                }
                if (exportedName !== SINGLE_AWAKE_WRAPPER
                    && !isMissionModuleSpecifier(moduleSpecifier)) {
                    ts.forEachChild(node, visit)
                    return
                }
                const callee = CALLEES.get(exportedName)
                if (callee === undefined) {
                    throw new Error(`${fileName} calls unknown Awake publication helper ${exportedName}`)
                }
                calls.push({ callee, call: node, exportedName, moduleSpecifier, sourceFile })
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

function createTypeCheckedSource(source, fileName) {
    const compilerOptions = {
        module: ts.ModuleKind.CommonJS,
        noEmit: true,
        noLib: true,
        noResolve: true,
        target: ts.ScriptTarget.Latest,
    }
    const parsedSourceFile = ts.createSourceFile(
        fileName,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    )
    const defaultHost = ts.createCompilerHost(compilerOptions)
    const host = {
        ...defaultHost,
        fileExists: requested => requested === fileName,
        getSourceFile: requested => requested === fileName ? parsedSourceFile : undefined,
        readFile: requested => requested === fileName ? source : undefined,
        writeFile() {},
    }
    const program = ts.createProgram({
        rootNames: [fileName],
        options: compilerOptions,
        host,
    })
    return {
        checker: program.getTypeChecker(),
        sourceFile: program.getSourceFile(fileName),
    }
}

function findNamedImportSymbol(sourceFile, checker, exportedName, moduleMatches) {
    const symbols = []
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || !moduleMatches(statement.moduleSpecifier.text)) continue
        const bindings = statement.importClause?.namedBindings
        if (!bindings || !ts.isNamedImports(bindings)) continue
        for (const element of bindings.elements) {
            if ((element.propertyName?.text ?? element.name.text) !== exportedName) continue
            const symbol = checker.getSymbolAtLocation(element.name)
            if (symbol !== undefined) symbols.push(symbol)
        }
    }
    assert.equal(
        symbols.length,
        1,
        `${sourceFile.fileName} must import ${exportedName} exactly once`,
    )
    return symbols[0]
}

function collectCallsForSymbol(root, checker, symbol, { stopAtNestedFunctions = false } = {}) {
    const calls = []
    function visit(node) {
        if (stopAtNestedFunctions && node !== root && ts.isFunctionLike(node)) return
        if (ts.isCallExpression(node)
            && ts.isIdentifier(node.expression)
            && checker.getSymbolAtLocation(node.expression) === symbol) calls.push(node)
        ts.forEachChild(node, visit)
    }
    visit(root)
    return calls
}

function findExportedFunctionDeclaration(sourceFile, checker, exportedName) {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
    assert.notEqual(
        moduleSymbol,
        undefined,
        `${sourceFile.fileName} must be an external module`,
    )
    const exportedSymbol = checker.getExportsOfModule(moduleSymbol)
        .find(symbol => symbol.name === exportedName)
    const declarations = (exportedSymbol?.getDeclarations() ?? [])
        .filter(ts.isFunctionDeclaration)
    assert.equal(
        declarations.length,
        1,
        `${sourceFile.fileName} must export function ${exportedName} exactly once`,
    )
    return declarations[0]
}

function assertSingleAwakePublicationWrapper() {
    const relativeFile = "src/lib/mission/awake-best-effort-context.ts"
    const source = fs.readFileSync(path.join(projectRoot, relativeFile), "utf8")
    const { checker, sourceFile } = createTypeCheckedSource(source, relativeFile)
    const wrapper = findExportedFunctionDeclaration(
        sourceFile,
        checker,
        SINGLE_AWAKE_WRAPPER,
    )
    const candidateSymbol = findNamedImportSymbol(
        sourceFile,
        checker,
        "collectAwakeCandidateCharacterIds",
        specifier => specifier.endsWith("/awake-candidate-character-ids"),
    )
    const reconcileSymbol = findNamedImportSymbol(
        sourceFile,
        checker,
        "reconcileAwakeUnlockCharacterListBestEffort",
        specifier => specifier.endsWith("/awake-unlock-response"),
    )
    const contextDeclaration = findExportedFunctionDeclaration(
        sourceFile,
        checker,
        "createAwakeRequestContextBestEffort",
    )
    const contextSymbol = checker.getSymbolAtLocation(contextDeclaration.name)
    assert.notEqual(contextSymbol, undefined)

    const candidateCalls = collectCallsForSymbol(wrapper, checker, candidateSymbol)
    assert.equal(candidateCalls.length, 1, "single Awake wrapper must collect candidates exactly once")
    assert.deepEqual(
        candidateCalls[0].arguments.map(argument => argument.getText(sourceFile)),
        ["explicitCharacterIds", "characterLists"],
    )

    const contextCalls = collectCallsForSymbol(wrapper, checker, contextSymbol)
    assert.equal(contextCalls.length, 1, "single Awake wrapper must create context exactly once")
    assert.deepEqual(
        contextCalls[0].arguments.map(argument => argument.getText(sourceFile)),
        ["playerId", "candidateCharacterIds", "scope"],
    )

    const reconcileCalls = collectCallsForSymbol(wrapper, checker, reconcileSymbol)
    assert.equal(reconcileCalls.length, 1, "single Awake wrapper must reconcile exactly once")
    assert.deepEqual(
        reconcileCalls[0].arguments.map(argument => argument.getText(sourceFile)),
        [
            "playerId",
            "existingCharacterList",
            "{ context: awakeContext }",
        ],
    )
}

function assertSingleSettlementTransactionOwnership(source, fileName) {
    const { checker, sourceFile } = createTypeCheckedSource(source, fileName)
    const owner = findExportedFunctionDeclaration(
        sourceFile,
        checker,
        "settleSingleBattleQuest",
    )
    const writesImportSymbol = findNamedImportSymbol(
        sourceFile,
        checker,
        "executeSingleSettlementWrites",
        specifier => specifier.endsWith("/single-settlement-writes")
            || specifier === "./single-settlement-writes",
    )
    const transactionImportSymbol = findNamedImportSymbol(
        sourceFile,
        checker,
        "runSingleFinishSettlementTransaction",
        specifier => specifier.endsWith("/single-finish-settlement")
            || specifier === "./single-finish-settlement",
    )
    const transactionCalls = collectCallsForSymbol(
        owner,
        checker,
        transactionImportSymbol,
        { stopAtNestedFunctions: true },
    )
    assert.equal(
        transactionCalls.length,
        1,
        `${fileName} settleSingleBattleQuest must directly call production import `
            + "runSingleFinishSettlementTransaction transaction exactly once",
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
        collectCallsForSymbol(settleCallback, checker, writesImportSymbol, {
            stopAtNestedFunctions: true,
        }).length > 0,
        true,
        `${fileName} settle callback must call production import executeSingleSettlementWrites`,
    )
}

function assertMultiSettlementTransactionOwnership(source, fileName) {
    const { checker, sourceFile } = createTypeCheckedSource(source, fileName)
    const owner = findExportedFunctionDeclaration(
        sourceFile,
        checker,
        "runMultiplayerSettlementOrchestration",
    )
    const awakeImportSymbol = findNamedImportSymbol(
        sourceFile,
        checker,
        source.includes("reconcileAwakeUnlockCharacterListBestEffort")
            ? "reconcileAwakeUnlockCharacterListBestEffort"
            : "reconcileAwakeUnlockCharacterList",
        isMissionModuleSpecifier,
    )
    const awakeCalls = collectCallsForSymbol(sourceFile, checker, awakeImportSymbol)
    assert.equal(
        awakeCalls.length,
        1,
        `${fileName} must contain exactly one imported Awake publication call`,
    )
    const awakeCall = awakeCalls[0]
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
    const executeSymbol = checker.getSymbolAtLocation(executeDeclaration.name)
    assert.notEqual(
        executeSymbol,
        undefined,
        `${sourceFile.fileName} executeFinishWrites declaration must have a symbol`,
    )
    const transactionImportSymbol = findNamedImportSymbol(
        sourceFile,
        checker,
        "runMultiActiveQuestSettlementTransaction",
        specifier => specifier.endsWith("/active-quest-service")
            || specifier === "./active-quest-service",
    )
    const transactionCalls = collectCallsForSymbol(
        owner,
        checker,
        transactionImportSymbol,
        { stopAtNestedFunctions: true },
    )
    assert.equal(
        transactionCalls.length,
        1,
        `${sourceFile.fileName} runMultiplayerSettlementOrchestration must directly call `
            + "production import runMultiActiveQuestSettlementTransaction transaction exactly once",
    )
    const writesArgument = transactionCalls[0].arguments[2]
    assert.equal(
        writesArgument !== undefined
            && ts.isIdentifier(writesArgument)
            && checker.getSymbolAtLocation(writesArgument) === executeSymbol,
        true,
        `${sourceFile.fileName} transaction third argument must reference the Awake executeFinishWrites declaration`,
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
        assertMultiSettlementTransactionOwnership(call.getSourceFile().text, relativeFile)
        return "best-effort-in-tx"
    }
    const inTransaction = isInsideDirectTransaction(call)
    if (callee === "strict") {
        assert.equal(inTransaction, true, `${relativeFile} strict publication left its transaction`)
        return "strict-in-tx"
    }
    return inTransaction ? "best-effort-in-tx" : "best-effort-post-commit"
}

function compactExpression(node, sourceFile) {
    return node.getText(sourceFile).replace(/\s+/g, " ").trim()
}

function propertyName(property) {
    if (!property.name) return null
    if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text
    return null
}

function getObjectProperty(object, name) {
    if (!object || !ts.isObjectLiteralExpression(object)) return null
    for (const property of object.properties) {
        if (propertyName(property) !== name) continue
        if (ts.isShorthandPropertyAssignment(property)) return property.name
        if (ts.isPropertyAssignment(property)) return property.initializer
    }
    return null
}

function callTerminalName(call) {
    const expression = call.expression
    if (ts.isIdentifier(expression)) return expression.text
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text
    return null
}

function findContextCreation(call, sourceFile) {
    const options = call.arguments[2]
    const contextReference = getObjectProperty(options, "context")
    assert.equal(
        contextReference !== null && ts.isIdentifier(contextReference),
        true,
        `${sourceFile.fileName} scoped reconcile must reference a context variable`,
    )
    let creation = null
    function visit(node) {
        if (node.getStart(sourceFile) >= call.getStart(sourceFile)) return
        if (ts.isVariableDeclaration(node)
            && ts.isIdentifier(node.name)
            && node.name.text === contextReference.text
            && node.initializer
            && ts.isCallExpression(node.initializer)
            && callTerminalName(node.initializer)?.startsWith("createAwakeRequestContext")) {
            creation = node.initializer
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    assert.notEqual(creation, null, `${sourceFile.fileName} context creation is not statically traceable`)
    return creation
}

function classifyFactSeeds(scope, sourceFile) {
    const factSeeds = getObjectProperty(scope, "invalidatedFactKeys")
    if (factSeeds === null) return "none"
    const text = compactExpression(factSeeds, sourceFile)
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(text)) return text
    const hasRewardFacts = text.includes("getAwakeFactKeysFromLegacyRewardResults")
    if (hasRewardFacts && text.includes("questProgress")) return "story-reward+quest-progress"
    if (hasRewardFacts) return "reward-result"
    if (text.includes("getMailAwakeInvalidatedFactKeys")) return "mail"
    if (/kind:\s*["']player["']/.test(text)) return "player"
    assert.fail(`${sourceFile.fileName} has an unclassified Awake FactKey seed expression: ${text}`)
}

function extractScopeEvidence(importedCall) {
    const { call, exportedName, sourceFile } = importedCall
    let actualCharacterSeed
    let scope
    let contextStart
    if (exportedName === SINGLE_AWAKE_WRAPPER) {
        actualCharacterSeed = compactExpression(call.arguments[1], sourceFile)
        scope = call.arguments[3]
        contextStart = call.getStart(sourceFile)
    } else {
        const creation = findContextCreation(call, sourceFile)
        contextStart = creation.getStart(sourceFile)
        if (callTerminalName(creation) === "createAwakeRequestContext") {
            scope = creation.arguments[0]
            const candidate = getObjectProperty(scope, "candidateCharacterIds")
            actualCharacterSeed = candidate === null ? "full-category9" : compactExpression(candidate, sourceFile)
        } else {
            actualCharacterSeed = compactExpression(creation.arguments[1], sourceFile)
            scope = creation.arguments[2]
        }
    }
    const directMissionIds = getObjectProperty(scope, "directMissionIds")
    const snapshotProperties = scope && ts.isObjectLiteralExpression(scope)
        ? scope.properties.map(propertyName).filter(name => name?.toLowerCase().includes("snapshot"))
        : []
    return {
        actualCharacterSeed,
        actualFactSeeds: classifyFactSeeds(scope, sourceFile),
        directMissionSeed: directMissionIds === null
            ? "none"
            : compactExpression(directMissionIds, sourceFile),
        snapshotSource: snapshotProperties.length === 0
            ? "none"
            : snapshotProperties.sort().join("+"),
        contextStart,
    }
}

function findOwnerRoot(call) {
    for (let parent = call.parent; parent; parent = parent.parent) {
        if (ts.isCallExpression(parent)
            && ts.isPropertyAccessExpression(parent.expression)
            && parent.expression.name.text === "post") {
            const callback = parent.arguments.find(argument => (
                ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
            ))
            if (callback) return callback
        }
    }
    for (let parent = call.parent; parent; parent = parent.parent) {
        if (ts.isFunctionDeclaration(parent) && parent.name) return parent
        if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent))
            && ts.isVariableDeclaration(parent.parent)
            && ts.isIdentifier(parent.parent.name)) return parent
    }
    assert.fail(`${call.getSourceFile().fileName} publication owner root is not traceable`)
}

function assertFinalWritePrecedesContext(call, contextStart, anchor, ownerLabel = null) {
    const sourceFile = call.getSourceFile()
    const ownerRoot = findOwnerRoot(call)
    const matches = []
    function visit(node) {
        if (ts.isCallExpression(node)
            && callTerminalName(node) === anchor) matches.push(node)
        ts.forEachChild(node, visit)
    }
    visit(ownerRoot)
    const publicationBlocks = []
    for (let node = call.parent; node && node !== ownerRoot; node = node.parent) {
        if (ts.isBlock(node)) publicationBlocks.push(node)
    }
    const belongsToBlockPath = (match, block) => {
        for (let node = match.parent; node && node !== block; node = node.parent) {
            if (ts.isFunctionLike(node)) {
                const callExpression = node.parent
                const synchronousMailFilter = ownerLabel === "mail/receive_all"
                    && ts.isCallExpression(callExpression)
                    && callExpression.arguments.includes(node)
                    && ts.isPropertyAccessExpression(callExpression.expression)
                    && callExpression.expression.name.text === "filter"
                if (!synchronousMailFilter) return false
            }
        }
        return true
    }
    let dominanceEvidence = null
    for (const block of publicationBlocks) {
        const publicationStatement = block.statements.find(statement => (
            call.getStart(sourceFile) >= statement.getStart(sourceFile)
                && call.end <= statement.end
        ))
        if (publicationStatement === undefined) continue
        const publicationIndex = block.statements.indexOf(publicationStatement)
        const writeStatement = block.statements.find(statement => matches.some(match => (
            match.end <= contextStart
                && belongsToBlockPath(match, block)
                && match.getStart(sourceFile) >= statement.getStart(sourceFile)
                && match.end <= statement.end
        )))
        if (writeStatement === undefined) continue
        const writeIndex = block.statements.indexOf(writeStatement)
        if (writeIndex < publicationIndex) {
            dominanceEvidence = { block, publicationIndex }
            break
        }
    }
    assert.equal(
        dominanceEvidence !== null,
        true,
        `${sourceFile.fileName} final authoritative write ${anchor} does not dominate publication on the same control-flow path`,
    )
    const later = dominanceEvidence.block.statements.filter((statement, index) => (
        index > dominanceEvidence.publicationIndex
            && matches.some(match => (
                belongsToBlockPath(match, dominanceEvidence.block)
                    && match.getStart(sourceFile) >= statement.getStart(sourceFile)
                    && match.end <= statement.end
            ))
    ))
    assert.equal(
        later.length,
        0,
        `${sourceFile.fileName} has a later authoritative write ${anchor} after publication`,
    )
}

function collectProductionCalls() {
    const files = ts.sys.readDirectory(sourceRoot, [".ts"], undefined, undefined)
    const calls = []
    for (const file of files) {
        const relativeFile = path.relative(projectRoot, file).split(path.sep).join("/")
        if (relativeFile === "src/lib/mission/awake-unlock-response.ts") continue
        const source = fs.readFileSync(file, "utf8")
        for (const importedCall of collectImportedAwakeCalls(source, relativeFile)) {
            const { call, callee, exportedName, moduleSpecifier, sourceFile } = importedCall
            if (exportedName === SINGLE_AWAKE_WRAPPER) {
                assert.equal(
                    moduleSpecifier.endsWith("/awake-best-effort-context"),
                    true,
                    `${relativeFile} post-commit wrapper import must use awake-best-effort-context`,
                )
                assert.equal(call.arguments.length, 4, `${relativeFile} wrapper must receive explicit scope`)
                assert.equal(
                    ts.isObjectLiteralExpression(call.arguments[3]),
                    true,
                    `${relativeFile} wrapper fourth argument must be an object expression`,
                )
                if (relativeFile === "src/lib/quest/finish/single-settlement-writes.ts") {
                    assertSingleAwakePublicationWrapper()
                }
            } else {
                assert.ok(
                    call.arguments.length === 2 || call.arguments.length === 3,
                    `${relativeFile} publication must use the supported signature`,
                )
            }
            if (call.arguments.length === 3 && exportedName !== SINGLE_AWAKE_WRAPPER) {
                const options = call.arguments[2]
                assert.equal(
                    ts.isObjectLiteralExpression(options),
                    true,
                    `${relativeFile} scoped publication must pass an options object`,
                )
                const optionNames = new Set(options.properties.flatMap(property => {
                    if (ts.isShorthandPropertyAssignment(property)) return [property.name.text]
                    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) return [property.name.text]
                    return []
                }))
                assert.equal(optionNames.has("context"), true, `${relativeFile} scoped publication must pass fresh context`)
            }
            const ownerLabel = classifyOwner(relativeFile, call, sourceFile)
            const expected = EXPECTED_MATRIX.filter(entry => entry.owner === ownerLabel)
            assert.equal(expected.length, 1, `${ownerLabel} must have exactly one matrix row`)
            const scopeEvidence = extractScopeEvidence(importedCall)
            assertFinalWritePrecedesContext(
                call,
                scopeEvidence.contextStart,
                expected[0].finalAuthoritativeWrite,
                ownerLabel,
            )
            assert.equal(
                typeof PLANNED_CANDIDATE_SOURCES[ownerLabel],
                "string",
                `${relativeFile} Awake owner must have a planned candidate source`,
            )
            calls.push({
                relativeFile,
                callee,
                ownerLabel,
                boundary: classifyBoundary(relativeFile, callee, call),
                candidateSource: (
                    exportedName === SINGLE_AWAKE_WRAPPER
                        ? call.arguments.length === 4
                        : call.arguments.length === 3
                ) ? "scoped-context" : "legacy-unscoped",
                plannedCandidateSource: PLANNED_CANDIDATE_SOURCES[ownerLabel],
                owner: ownerLabel,
                actualCharacterSeed: scopeEvidence.actualCharacterSeed,
                actualFactSeeds: scopeEvidence.actualFactSeeds,
                directMissionSeed: scopeEvidence.directMissionSeed,
                finalAuthoritativeWrite: expected[0].finalAuthoritativeWrite,
                snapshotSource: scopeEvidence.snapshotSource,
                rereadReason: expected[0].rereadReason,
                sqlUpperBoundKey: expected[0].sqlUpperBoundKey,
                runtimeEvidenceKey: expected[0].runtimeEvidenceKey,
                position: call.getStart(sourceFile),
            })
        }
    }
    return calls.sort((left, right) => (
        left.relativeFile.localeCompare(right.relativeFile) || left.position - right.position
    ))
}

function assertEvidenceContract(matrix) {
    assert.equal(matrix.length, 21, "Awake owner matrix must contain exactly 21 rows")
    assert.equal(new Set(matrix.map(entry => entry.owner)).size, 21, "Awake owners must be unique")
    assert.deepEqual(
        Object.fromEntries(["strict-in-tx", "best-effort-in-tx", "best-effort-post-commit"]
            .map(boundary => [boundary, matrix.filter(entry => entry.boundary === boundary).length])),
        { "strict-in-tx": 1, "best-effort-in-tx": 9, "best-effort-post-commit": 11 },
    )
    for (const entry of matrix) {
        assert.equal(
            entry.changesGlobalFacts,
            GLOBAL_FACT_OWNERS.has(entry.owner),
            `${entry.owner} global-fact ownership drifted`,
        )
        const runtimeEvidence = AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY[entry.runtimeEvidenceKey]
        assert.notEqual(runtimeEvidence, undefined, `${entry.owner} runtime evidence key must resolve`)
        assert.equal(runtimeEvidence.boundary, entry.boundary, `${entry.owner} evidence boundary drifted`)
        assert.equal(runtimeEvidence.owners.includes(entry.owner), true, `${entry.owner} is absent from its evidence family`)
        assert.equal(runtimeEvidence.scenarios.length > 0, true, `${entry.owner} has no runtime scenario`)
        const ownerScenarios = runtimeEvidence.scenarios.map(name => (
            OWNER_FOCUSED_SNAPSHOT.scenarios[name]
        )).filter(scenario => scenario?.owner === entry.owner)
        assert.equal(
            ownerScenarios.length,
            1,
            `${entry.owner} lacks exactly one owner-matched runtime scenario`,
        )
        const runtimeScenario = ownerScenarios[0]
        assert.equal(runtimeScenario.runtimeEvidenceKey, entry.runtimeEvidenceKey)
        assert.equal(runtimeScenario.boundary, entry.boundary)
        assert.deepEqual(runtimeScenario.characterSeeds, runtimeScenario.publicationObservation.characterSeeds)
        assert.deepEqual(runtimeScenario.factSeeds, runtimeScenario.publicationObservation.factSeeds)
        assert.deepEqual(runtimeScenario.directMissionSeeds, runtimeScenario.publicationObservation.directMissionSeeds)
        assert.deepEqual(runtimeScenario.characterSeeds, runtimeEvidence.seedContract.characterSeeds)
        assert.deepEqual(runtimeScenario.factSeeds, runtimeEvidence.seedContract.factSeeds)
        assert.deepEqual(runtimeScenario.directMissionSeeds, runtimeEvidence.seedContract.directMissionSeeds)
        assert.notEqual(
            AWAKE_OWNER_SQL_UPPER_BOUND_REGISTRY[entry.sqlUpperBoundKey],
            undefined,
            `${entry.owner} SQL upper-bound key must resolve`,
        )
        if (entry.changesGlobalFacts) {
            assert.notEqual(entry.actualFactSeeds, "none", `${entry.owner} omitted changed global facts`)
        }
        if (entry.snapshotSource !== "none") {
            assert.match(entry.snapshotSource, /snapshot/i, `${entry.owner} claims reuse without a snapshot injection`)
        }
        if (entry.actualCharacterSeed === "full-category9") {
            assert.match(entry.rereadReason, /full|recovery|unbounded/i, `${entry.owner} full Category 9 scope lacks a concrete reason`)
            assert.notEqual(entry.sqlUpperBoundKey, "", `${entry.owner} full Category 9 scope lacks an SQL upper bound`)
        }
    }
    const registeredOwners = Object.values(AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY)
        .flatMap(entry => entry.owners).sort()
    assert.deepEqual(registeredOwners, matrix.map(entry => entry.owner).sort())
}

test("Awake reconcile production call expressions match the fixed 21-entry evidence matrix", () => {
    const calls = collectProductionCalls()
    assert.equal(calls.length, 21)
    const comparedFields = [
        "relativeFile", "callee", "owner", "boundary", "candidateSource",
        "plannedCandidateSource", "actualCharacterSeed", "actualFactSeeds",
        "directMissionSeed", "finalAuthoritativeWrite", "snapshotSource",
        "rereadReason", "sqlUpperBoundKey", "runtimeEvidenceKey",
    ]
    assert.deepEqual(
        calls.map(call => Object.fromEntries(comparedFields.map(field => [field, call[field]]))),
        EXPECTED_MATRIX.map(entry => Object.fromEntries(comparedFields.map(field => [field, entry[field]]))),
    )
    assert.equal(new Set(calls.map(call => `${call.relativeFile}:${call.position}`)).size, 21)
    assertEvidenceContract(EXPECTED_MATRIX)
})

test("Awake reconcile audit matrix freezes owner, policy, and planned candidate source", () => {
    assert.equal(EXPECTED_MATRIX.length, 21)
    assert.deepEqual(
        Object.fromEntries(["strict-in-tx", "best-effort-in-tx", "best-effort-post-commit"]
            .map(boundary => [
                boundary,
                EXPECTED_MATRIX.filter(entry => entry.boundary === boundary).length,
            ])),
        {
            "strict-in-tx": 1,
            "best-effort-in-tx": 9,
            "best-effort-post-commit": 11,
        },
    )
    assert.equal(new Set(EXPECTED_MATRIX.map(entry => entry.ownerLabel)).size, 21)
    for (const entry of EXPECTED_MATRIX) {
        assert.equal(
            entry.candidateSource,
            entry.boundary === "strict-in-tx" || entry.boundary === "best-effort-in-tx"
                ? "scoped-context"
                : "scoped-context",
        )
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

test("35.5D audit rows carry the complete fixed 21-owner evidence contract", () => {
    const missing = EXPECTED_MATRIX.flatMap((entry, index) => (
        REQUIRED_OWNER_EVIDENCE_FIELDS
            .filter(field => !Object.hasOwn(entry, field))
            .map(field => `${index}:${entry.ownerLabel}:${field}`)
    ))
    assert.deepEqual(missing, [], `matrix evidence fields are missing: ${missing.join(", ")}`)
    assert.equal(EXPECTED_MATRIX.length, 21)
    assert.equal(EXPECTED_MATRIX.some(entry => entry.owner === "pass_card/receive_all"), true)
    assert.equal(EXPECTED_MATRIX.some(entry => entry.owner === "raid_event/summary"), true)
})

test("35.5D matrix invariants fail closed on evidence omissions and grouping drift", () => {
    for (const mutate of [
        matrix => matrix.pop(),
        matrix => { matrix[1].owner = matrix[0].owner },
        matrix => { matrix[0].boundary = "best-effort-post-commit" },
        matrix => { matrix[0].actualFactSeeds = "none" },
        matrix => { matrix[0].runtimeEvidenceKey = "missing-runtime-evidence" },
        matrix => { matrix[0].sqlUpperBoundKey = "missing-sql-bound" },
        matrix => {
            matrix[0].actualCharacterSeed = "full-category9"
            matrix[0].rereadReason = "compatibility"
        },
    ]) {
        const changed = structuredClone(EXPECTED_MATRIX)
        mutate(changed)
        assert.throws(() => assertEvidenceContract(changed))
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

test("AST collector fails closed on local and namespace shadowing", () => {
    const localShadow = `
        import { reconcileAwakeUnlockCharacterListBestEffort } from "./mission"
        export function run() {
            function reconcileAwakeUnlockCharacterListBestEffort() { return [] }
            return reconcileAwakeUnlockCharacterListBestEffort(1, [])
        }
    `
    const namespaceShadow = `
        import * as missionApi from "./mission"
        export function run(missionApi) {
            return missionApi.reconcileAwakeUnlockCharacterListBestEffort(1, [])
        }
    `
    assert.deepEqual(collectImportedAwakeCalls(localShadow, "synthetic.ts"), [])
    assert.deepEqual(collectImportedAwakeCalls(namespaceShadow, "synthetic.ts"), [])
})

test("AST collector enforces the single wrapper module contract", () => {
    const wrongModule = `
        import { publishAwakeCharacterListBestEffort } from "./mission"
        publishAwakeCharacterListBestEffort(1, [], [])
    `
    assert.throws(
        () => collectImportedAwakeCalls(wrongModule, "synthetic.ts"),
        /single Awake wrapper import must use awake-best-effort-context/i,
    )
})

test("final-write evidence rejects a same-name write confined to a sibling branch", () => {
    const source = `
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner(condition) {
            if (condition) {
                persistPlayer()
            } else {
                publishAwakeCharacterListBestEffort(1, [], [], {})
            }
        }
    `
    const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]
    const scope = extractScopeEvidence(importedCall)

    assert.throws(
        () => assertFinalWritePrecedesContext(importedCall.call, scope.contextStart, "persistPlayer"),
        /same control-flow path|dominat/i,
    )
})

test("final-write evidence rejects authoritative writes after publication", () => {
    const source = `
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner() {
            persistPlayer()
            publishAwakeCharacterListBestEffort(1, [], [], {})
            persistPlayer()
        }
    `
    const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]
    const scope = extractScopeEvidence(importedCall)

    assert.throws(
        () => assertFinalWritePrecedesContext(importedCall.call, scope.contextStart, "persistPlayer"),
        /after.*publication|later authoritative write/i,
    )
})

test("single settlement ownership requires writes inside the settle callback", () => {
    const owned = `
        import { executeSingleSettlementWrites } from "./single-settlement-writes"
        import { runSingleFinishSettlementTransaction } from "./single-finish-settlement"
        export function settleSingleBattleQuest() {
            return runSingleFinishSettlementTransaction({
                settle: () => executeSingleSettlementWrites({}),
            })
        }
    `
    const movedOutside = `
        import { executeSingleSettlementWrites } from "./single-settlement-writes"
        import { runSingleFinishSettlementTransaction } from "./single-finish-settlement"
        executeSingleSettlementWrites({})
        export function settleSingleBattleQuest() {
            return runSingleFinishSettlementTransaction({ settle: () => ({}) })
        }
    `
    const nestedOnly = `
        import { executeSingleSettlementWrites } from "./single-settlement-writes"
        import { runSingleFinishSettlementTransaction } from "./single-finish-settlement"
        export function settleSingleBattleQuest() {
            return runSingleFinishSettlementTransaction({
                settle: () => {
                    const deferred = () => executeSingleSettlementWrites({})
                    return {}
                },
            })
        }
    `
    const locallyShadowed = `
        import { executeSingleSettlementWrites } from "./single-settlement-writes"
        import { runSingleFinishSettlementTransaction } from "./single-finish-settlement"
        export function settleSingleBattleQuest() {
            return runSingleFinishSettlementTransaction({
                settle: () => {
                    function executeSingleSettlementWrites() { return true }
                    return executeSingleSettlementWrites({})
                },
            })
        }
    `
    const singleLocalFakeTransactionHelper = `
        import { executeSingleSettlementWrites } from "./single-settlement-writes"
        import { runSingleFinishSettlementTransaction } from "./single-finish-settlement"
        export function settleSingleBattleQuest() {
            function runSingleFinishSettlementTransaction(options) { return options.settle() }
            return runSingleFinishSettlementTransaction({
                settle: () => executeSingleSettlementWrites({}),
            })
        }
    `
    const singleDeadImportedTransaction = `
        import { executeSingleSettlementWrites } from "./single-settlement-writes"
        import { runSingleFinishSettlementTransaction } from "./single-finish-settlement"
        function neverCalled() {
            return runSingleFinishSettlementTransaction({
                settle: () => executeSingleSettlementWrites({}),
            })
        }
        export function settleSingleBattleQuest() {
            function runSingleFinishSettlementTransaction(options) { return options.settle() }
            return runSingleFinishSettlementTransaction({
                settle: () => executeSingleSettlementWrites({}),
            })
        }
    `

    assert.doesNotThrow(() => assertSingleSettlementTransactionOwnership(owned, "single.ts"))
    assert.throws(
        () => assertSingleSettlementTransactionOwnership(movedOutside, "single.ts"),
        /settle callback.*executeSingleSettlementWrites/i,
    )
    assert.throws(
        () => assertSingleSettlementTransactionOwnership(nestedOnly, "single.ts"),
        /settle callback.*executeSingleSettlementWrites/i,
    )
    assert.throws(
        () => assertSingleSettlementTransactionOwnership(locallyShadowed, "single.ts"),
        /production import.*executeSingleSettlementWrites/i,
    )
    assert.throws(
        () => assertSingleSettlementTransactionOwnership(
            singleLocalFakeTransactionHelper,
            "single.ts",
        ),
        /production import.*runSingleFinishSettlementTransaction/i,
    )
    assert.throws(
        () => assertSingleSettlementTransactionOwnership(
            singleDeadImportedTransaction,
            "single.ts",
        ),
        /settleSingleBattleQuest.*transaction/i,
    )
})

test("multi settlement ownership requires executeFinishWrites as the third argument", () => {
    const owned = `
        import { reconcileAwakeUnlockCharacterList } from "./mission"
        import { runMultiActiveQuestSettlementTransaction } from "./active-quest-service"
        export function runMultiplayerSettlementOrchestration() {
            const executeFinishWrites = () => reconcileAwakeUnlockCharacterList(1, [])
            const otherWrites = () => true
            return runMultiActiveQuestSettlementTransaction(1, {}, executeFinishWrites)
        }
    `
    const replaced = owned.replace(
        "runMultiActiveQuestSettlementTransaction(1, {}, executeFinishWrites)",
        "runMultiActiveQuestSettlementTransaction(1, {}, otherWrites)",
    )
    const shadowed = `
        import { reconcileAwakeUnlockCharacterList } from "./mission"
        import { runMultiActiveQuestSettlementTransaction } from "./active-quest-service"
        export function runMultiplayerSettlementOrchestration() {
            const executeFinishWrites = () => reconcileAwakeUnlockCharacterList(1, [])
            {
                const executeFinishWrites = () => true
                runMultiActiveQuestSettlementTransaction(1, {}, executeFinishWrites)
            }
        }
    `
    const parameterShadowed = `
        import { reconcileAwakeUnlockCharacterList } from "./mission"
        import { runMultiActiveQuestSettlementTransaction } from "./active-quest-service"
        const executeFinishWrites = () => reconcileAwakeUnlockCharacterList(1, [])
        export function runMultiplayerSettlementOrchestration(executeFinishWrites) {
            runMultiActiveQuestSettlementTransaction(1, {}, executeFinishWrites)
        }
    `
    const multiLocalFakeTransactionHelper = `
        import { reconcileAwakeUnlockCharacterList } from "./mission"
        import {
            runMultiActiveQuestSettlementTransaction,
        } from "./active-quest-service"
        const executeFinishWrites = () => reconcileAwakeUnlockCharacterList(1, [])
        export function runMultiplayerSettlementOrchestration() {
            function runMultiActiveQuestSettlementTransaction(_id, _request, writes) {
                return writes()
            }
            return runMultiActiveQuestSettlementTransaction(1, {}, executeFinishWrites)
        }
    `
    const multiDeadImportedTransaction = `
        import { reconcileAwakeUnlockCharacterList } from "./mission"
        import {
            runMultiActiveQuestSettlementTransaction,
        } from "./active-quest-service"
        const executeFinishWrites = () => reconcileAwakeUnlockCharacterList(1, [])
        function neverCalled() {
            return runMultiActiveQuestSettlementTransaction(1, {}, executeFinishWrites)
        }
        export function runMultiplayerSettlementOrchestration() {
            function runMultiActiveQuestSettlementTransaction(_id, _request, writes) {
                return writes()
            }
            return runMultiActiveQuestSettlementTransaction(1, {}, executeFinishWrites)
        }
    `

    for (const [source, expectedFailure] of [
        [owned, false],
        [replaced, true],
        [shadowed, true],
        [parameterShadowed, true],
    ]) {
        const assertion = () => assertMultiSettlementTransactionOwnership(source, "multi.ts")
        if (expectedFailure) assert.throws(assertion, /third argument.*executeFinishWrites/i)
        else assert.doesNotThrow(assertion)
    }
    assert.throws(
        () => assertMultiSettlementTransactionOwnership(
            multiLocalFakeTransactionHelper,
            "multi.ts",
        ),
        /production import.*runMultiActiveQuestSettlementTransaction/i,
    )
    assert.throws(
        () => assertMultiSettlementTransactionOwnership(
            multiDeadImportedTransaction,
            "multi.ts",
        ),
        /runMultiplayerSettlementOrchestration.*transaction/i,
    )
})

test("transaction ownership symbol checks support named aliases", () => {
    const singleAliased = `
        import { executeSingleSettlementWrites } from "./single-settlement-writes"
        import {
            runSingleFinishSettlementTransaction as runSingleTransaction,
        } from "./single-finish-settlement"
        export function settleSingleBattleQuest() {
            return runSingleTransaction({
                settle: () => executeSingleSettlementWrites({}),
            })
        }
    `
    const multiAliased = `
        import { reconcileAwakeUnlockCharacterList } from "./mission"
        import {
            runMultiActiveQuestSettlementTransaction as runMultiTransaction,
        } from "./active-quest-service"
        export function runMultiplayerSettlementOrchestration() {
            const executeFinishWrites = () => reconcileAwakeUnlockCharacterList(1, [])
            return runMultiTransaction(1, {}, executeFinishWrites)
        }
    `

    assert.doesNotThrow(() => assertSingleSettlementTransactionOwnership(
        singleAliased,
        "single.ts",
    ))
    assert.doesNotThrow(() => assertMultiSettlementTransactionOwnership(
        multiAliased,
        "multi.ts",
    ))
})
