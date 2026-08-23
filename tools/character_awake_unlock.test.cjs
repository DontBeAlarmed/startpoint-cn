require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const { after } = require("node:test")
const os = require("node:os")
const path = require("node:path")
const Database = require("better-sqlite3")
const ts = require("typescript")

const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const {
    installBundledGameplaySnapshot,
} = require("./helpers/install-bundled-gameplay-snapshot.cjs")

const previousContentSnapshot = productionContentSnapshotProvider.snapshot
const restoreBundledCharacterSnapshot = installBundledGameplaySnapshot()
function restoreBundledCharacterSnapshotOnExit() {
    restoreBundledCharacterSnapshot()
}
process.once("exit", restoreBundledCharacterSnapshotOnExit)
after(() => {
    process.removeListener("exit", restoreBundledCharacterSnapshotOnExit)
    restoreBundledCharacterSnapshot()
    assert.strictEqual(productionContentSnapshotProvider.snapshot, previousContentSnapshot)
})

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "awake-unlock-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
delete process.env.DATA_DIR
process.env.WDFP_DATABASE_DIR = databaseDirectory
let db

function cleanupDatabase() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanupDatabase)

function readProjectSource(relativePath) {
    return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8")
}

function readRouteSource(relativePath) {
    return readProjectSource(path.join("src/routes/api", relativePath))
}

function countOccurrences(source, value) {
    return source.split(value).length - 1
}

function getRouteBlock(source, route, nextRoute) {
    const start = source.indexOf(`fastify.post("${route}"`)
    assert.notEqual(start, -1, `missing route ${route}`)
    const end = nextRoute === undefined
        ? source.length
        : source.indexOf(`fastify.post("${nextRoute}"`, start)
    assert.notEqual(end, -1, `missing route ${nextRoute}`)
    return source.slice(start, end)
}

function getCalleeName(expression) {
    return ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
            ? expression.name.text
            : null
}

function findCalls(source, calleeName) {
    const sourceFile = ts.createSourceFile(
        "route-contract.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    )
    const calls = []

    function visit(node) {
        if (ts.isCallExpression(node)) {
            const name = getCalleeName(node.expression)
            if (name === calleeName) {
                const conditionalConditions = []
                const enclosingLoops = []
                const enclosingTransactionCallbacks = []
                let assignedVariable = null
                for (let parent = node.parent; parent; parent = parent.parent) {
                    if (ts.isConditionalExpression(parent)) {
                        conditionalConditions.push(parent.condition.getText(sourceFile))
                    }
                    if (ts.isForStatement(parent) || ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
                        enclosingLoops.push(ts.SyntaxKind[parent.kind])
                    }
                    if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent))
                        && ts.isCallExpression(parent.parent)
                        && parent.parent.arguments.includes(parent)
                        && getCalleeName(parent.parent.expression) === "transaction") {
                        enclosingTransactionCallbacks.push(parent.parent.expression.getText(sourceFile))
                    }
                    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
                        assignedVariable = parent.name.text
                    }
                }
                calls.push({
                    position: node.getStart(sourceFile),
                    arguments: node.arguments.map(argument => argument.getText(sourceFile)),
                    conditionalConditions,
                    enclosingLoops,
                    enclosingTransactionCallbacks,
                    assignedVariable,
                })
            }
        }
        ts.forEachChild(node, visit)
    }

    visit(sourceFile)
    return calls
}

function findPropertyAssignmentValues(source, propertyName) {
    const sourceFile = ts.createSourceFile(
        "route-contract.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    )
    const values = []

    function visit(node) {
        if (ts.isPropertyAssignment(node)) {
            const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
                ? node.name.text
                : null
            if (name === propertyName) values.push(node.initializer.getText(sourceFile))
        }
        ts.forEachChild(node, visit)
    }

    visit(sourceFile)
    return values
}

function findVariableInitializers(source, variableName) {
    const sourceFile = ts.createSourceFile(
        "route-contract.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    )
    const initializers = []

    function visit(node) {
        if (ts.isVariableDeclaration(node)
            && ts.isIdentifier(node.name)
            && node.name.text === variableName
            && node.initializer) {
            initializers.push(node.initializer.getText(sourceFile))
        }
        ts.forEachChild(node, visit)
    }

    visit(sourceFile)
    return initializers
}

function getOnlyCall(source, calleeName) {
    const calls = findCalls(source, calleeName)
    assert.equal(calls.length, 1, `expected one real call to ${calleeName}`)
    return calls[0]
}

function getLastCallPosition(source, calleeName) {
    const calls = findCalls(source, calleeName)
    assert.notEqual(calls.length, 0, `expected a real call to ${calleeName}`)
    return calls[calls.length - 1].position
}

function testAuthoritativeMutationRoutesPublishAwakeUnlocks() {
    const singleBattleProjectorSource = readProjectSource(
        "src/lib/quest/finish/single-response-projector.ts",
    )
    const singleBattleSource = readProjectSource("src/lib/quest/finish/single-settlement-writes.ts")
    const storySource = readRouteSource("storyQuest.ts")
    const bondSource = readRouteSource("character/bond.ts")
    const missionSource = readRouteSource("mission.ts")
    const mailSource = readRouteSource("mail.ts")
    const itemSource = readRouteSource("item.ts")
    const shopSource = readRouteSource("shop.ts")
    const shopPurchaseSource = readProjectSource("src/lib/event-shop-purchase.ts")
    const shopRewardGrantSource = readProjectSource("src/lib/shop-reward-grant.ts")
    const routeSources = [
        singleBattleSource,
        storySource,
        bondSource,
        missionSource,
        mailSource,
        itemSource,
        shopSource,
    ]

    for (const source of routeSources) {
        assert.equal(source.includes("reconcileAwakeUnlockCharacterList"), true)
    }

    const singleBattleCall = singleBattleSource.lastIndexOf("reconcileAwakeUnlockCharacterList(")
    assert.equal(countOccurrences(singleBattleSource, "reconcileAwakeUnlockCharacterList("), 1)
    assert.equal(singleBattleCall > singleBattleSource.indexOf("recordMissionBattleFacts(finishCtx, settlementTime)"), true)
    assert.equal(singleBattleCall > singleBattleSource.indexOf("givePlayerCharactersExpSync("), true)
    assert.equal(singleBattleCall > singleBattleSource.indexOf("handleRushEventFinish("), true)
    assert.equal(singleBattleCall > singleBattleSource.indexOf("handleCarnivalEventFinish({"), true)
    const singleBattleMergeBlock = singleBattleSource.slice(
        singleBattleSource.indexOf("const characterList = reconcileAwakeUnlockCharacterList("),
        singleBattleSource.indexOf("if (!isScoreAttackEvent)", singleBattleCall)
    )
    for (const existingSegment of [
        "...rewardCharacterExpResult.character_list",
        "...((clearReward?.character_list || [])",
        "...((sPlusClearReward?.character_list || [])",
        "...(scoreRewardsResult.character_list",
    ]) {
        assert.equal(singleBattleMergeBlock.includes(existingSegment), true)
    }
    assert.equal(singleBattleProjectorSource.includes('"character_list": characterList'), true)

    const storyCall = storySource.lastIndexOf("reconcileAwakeUnlockCharacterList(")
    assert.equal(countOccurrences(storySource, "reconcileAwakeUnlockCharacterList("), 1)
    assert.equal(storyCall > storySource.indexOf("insertPlayerQuestProgressSync("), true)
    assert.equal(storyCall > storySource.indexOf("updatePlayerQuestProgressSync("), true)
    assert.equal(storySource.includes("return getDb().transaction(() =>"), true)
    assert.equal(storySource.includes("const firstClear = questProgress?.finished !== true"), true)
    assert.equal(storySource.includes("const rewardResult = firstClear &&"), true)
    assert.equal(storySource.includes("if (firstClear)"), true)

    const bondReceiveBlock = bondSource.split('fastify.post("/receive_bond_token"')[1]
        .split('fastify.post("/open_mana_board"')[0]
    const bondReconcileCall = getOnlyCall(bondReceiveBlock, "reconcileAwakeUnlockCharacterList")
    assert.equal(countOccurrences(bondSource, "reconcileAwakeUnlockCharacterList("), 1)
    assert.equal(bondReconcileCall.enclosingTransactionCallbacks.length, 1)
    assert.equal(
        bondReconcileCall.position
            > getLastCallPosition(bondReceiveBlock, "updatePlayerCharacterBondTokenSync"),
        true
    )

    const missionUpdateBlock = missionSource.split('fastify.post("/update_mission_progress"')[1]
    assert.equal(countOccurrences(missionSource, "reconcileAwakeUnlockCharacterList("), 1)
    assert.equal(
        missionUpdateBlock.indexOf("reconcileAwakeUnlockCharacterList(")
            > missionUpdateBlock.indexOf("})()"),
        true
    )
    assert.equal(missionUpdateBlock.includes("settleAwakeMissionRewards"), false)
    assert.equal(missionUpdateBlock.includes("givePlayerReward"), false)
    assert.equal(missionUpdateBlock.includes("incrementPlayerCategoryMissionStage"), false)
    assert.equal(missionUpdateBlock.includes("character_list: characterList"), true)

    const mailIndexBlock = mailSource.split('fastify.post("/index"')[1]
        .split('fastify.post("/receive"')[0]
    const mailReceiveBlock = mailSource.split('fastify.post("/receive"')[1]
        .split('fastify.post("/receive_all"')[0]
    const mailReceiveAllBlock = mailSource.split('fastify.post("/receive_all"')[1]
    assert.equal(countOccurrences(mailSource, "reconcileAwakeUnlockCharacterList("), 2)
    assert.equal(mailIndexBlock.includes("reconcileAwakeUnlockCharacterList("), false)
    assert.equal(
        mailReceiveBlock.indexOf("reconcileAwakeUnlockCharacterList(")
            > mailReceiveBlock.indexOf("receiveMailSync("),
        true
    )
    assert.equal(
        mailReceiveBlock.indexOf("reconcileAwakeUnlockCharacterList(")
            > mailReceiveBlock.indexOf("applyMailReward("),
        true
    )
    assert.equal(
        mailReceiveAllBlock.indexOf("reconcileAwakeUnlockCharacterList(")
            > mailReceiveAllBlock.indexOf("receiveAllMailsSync("),
        true
    )

    const itemUseBlock = itemSource.split('fastify.post("/use_item"')[1]
        .split('fastify.post("/sell"')[0]
    const itemSellBlock = itemSource.split('fastify.post("/sell"')[1]
    assert.equal(countOccurrences(itemSource, "reconcileAwakeUnlockCharacterList("), 1)
    assert.equal(itemUseBlock.includes("reconcileAwakeUnlockCharacterList("), false)
    assert.equal(
        itemSellBlock.indexOf("reconcileAwakeUnlockCharacterList(")
            > itemSellBlock.indexOf("if (!result.ok)"),
        true
    )

    const shopBuyBlock = shopSource.split('fastify.post("/buy"')[1]
        .split('fastify.post("/get_sales_list"')[0]
    const enhancementBlock = shopBuyBlock.slice(
        shopBuyBlock.indexOf("// Equipment enhancement shop"),
        shopBuyBlock.indexOf("let purchaseResult")
    )
    const shopReadOnlyBlock = shopSource.split('fastify.post("/get_sales_list"')[1]
        .split('fastify.post("/bulk_buy"')[0]
    const shopBulkBuyBlock = shopSource.split('fastify.post("/bulk_buy"')[1]
    const genericShopPurchaseBlock = shopPurchaseSource
        .split("export function executeGenericShopPurchaseSync(")[1]
        .split("export function executeGenericShopBatchPurchaseSync(")[0]
    assert.equal(countOccurrences(shopSource, "reconcileAwakeUnlockCharacterList("), 2)
    assert.equal(enhancementBlock.includes("reconcileAwakeUnlockCharacterList("), false)
    assert.equal(
        shopBuyBlock.indexOf("reconcileAwakeUnlockCharacterList(")
            > shopBuyBlock.indexOf("executeGenericShopPurchaseSync("),
        true
    )
    assert.equal(
        genericShopPurchaseBlock.indexOf("dependencies.addPurchaseCounts(")
            > genericShopPurchaseBlock.indexOf("dependencies.grantRewards("),
        true
    )
    assert.deepEqual(
        findPropertyAssignmentValues(shopBuyBlock, "grantRewards"),
        ["grantShopRewardsInTransactionOwnerSync"]
    )
    assert.deepEqual(
        getOnlyCall(
            shopRewardGrantSource,
            "executeRewardGrantPlanInTransactionOwnerSync"
        ).arguments.slice(0, 3),
        ["playerId", "createShopRewardPlan(rewards)", "knownPlayerBefore"]
    )
    assert.equal(shopReadOnlyBlock.includes("reconcileAwakeUnlockCharacterList("), false)
    assert.equal(
        shopBulkBuyBlock.indexOf("reconcileAwakeUnlockCharacterList(")
            > shopBulkBuyBlock.indexOf("executeGenericShopBatchPurchaseSync("),
        true
    )

    for (const source of routeSources.filter(source => source !== missionSource)) {
        assert.equal(source.includes("settleAwakeMissionRewards"), false)
    }
}

testAuthoritativeMutationRoutesPublishAwakeUnlocks()

function testRemainingAuthoritativeMutationRoutesPublishAwakeUnlocks() {
    const multiRouteSource = readProjectSource("src/multi/http/battle.ts")
    const multiSettlementSource = readProjectSource("src/multi/settlement/orchestrator.ts")
    const multiResponseSource = readProjectSource("src/multi/settlement/response.ts")
    const activeMissionSource = readRouteSource("activeMission.ts")
    const boxGachaSource = readRouteSource("boxGacha.ts")

    const multiStartBlock = getRouteBlock(multiRouteSource, "/start", "/finish")
    const multiFinishBlock = getRouteBlock(multiRouteSource, "/finish", "/abort")
    const multiAbortBlock = getRouteBlock(multiRouteSource, "/abort", "/play_continue")
    const multiContinueBlock = getRouteBlock(multiRouteSource, "/play_continue")
    const multiCall = getOnlyCall(multiSettlementSource, "reconcileAwakeUnlockCharacterList")
    assert.equal(findCalls(multiSettlementSource, "reconcileAwakeUnlockCharacterList").length, 1)
    assert.deepEqual(multiCall.arguments.slice(0, 1), ["input.playerId"])
    assert.equal(multiCall.arguments[1].includes("rewardCharacterExpResult.character_list"), true)
    assert.equal(multiCall.arguments[1].includes("clearReward?.character_list"), true)
    assert.equal(multiCall.arguments[1].includes("sPlusClearReward?.character_list"), true)
    assert.equal(multiCall.arguments[1].includes("scoreRewardsResult.character_list"), true)
    assert.equal(multiCall.position > multiSettlementSource.indexOf("const executeFinishWrites = () =>"), true)
    for (const persistenceCall of [
        "insertPlayerQuestProgressSync",
        "updatePlayerQuestProgressSync",
        "updatePlayerSync",
        "givePlayerScoreRewardsSync",
        "recordMissionBattleFacts",
        "givePlayerCharactersExpSync",
    ]) {
        assert.equal(multiCall.position > getLastCallPosition(multiSettlementSource, persistenceCall), true)
    }
    assert.equal(
        multiSettlementSource.indexOf("runMultiActiveQuestSettlementTransaction(") > multiCall.position,
        true,
    )
    assert.deepEqual(findPropertyAssignmentValues(multiResponseSource, "character_list"), ["characterList"])
    assert.match(multiFinishBlock, /runMultiplayerSettlementOrchestration\(/)
    assert.equal(findCalls(multiStartBlock, "reconcileAwakeUnlockCharacterList").length, 0)
    assert.equal(findCalls(multiAbortBlock, "reconcileAwakeUnlockCharacterList").length, 0)
    assert.equal(findCalls(multiContinueBlock, "reconcileAwakeUnlockCharacterList").length, 0)

    const activeReceiveBlock = getRouteBlock(activeMissionSource, "/receive")
    const activeMissionCall = getOnlyCall(activeReceiveBlock, "reconcileAwakeUnlockCharacterList")
    assert.equal(findCalls(activeMissionSource, "reconcileAwakeUnlockCharacterList").length, 1)
    assert.deepEqual(activeMissionCall.arguments, ["playerId", "existingCharacterList"])
    assert.equal(activeMissionCall.position > activeReceiveBlock.indexOf("if (!validation.ok)"), true)
    assert.equal(activeMissionCall.position > getLastCallPosition(activeReceiveBlock, "updatePlayerActiveMissionStageSync"), true)
    assert.equal(activeMissionCall.position > getLastCallPosition(activeReceiveBlock, "grant"), true)
    assert.equal(activeMissionCall.position > getLastCallPosition(activeReceiveBlock, "persistPlayer"), true)
    assert.deepEqual(activeMissionCall.conditionalConditions, ["validation.claims.length > 0"])
    assert.deepEqual(activeMissionCall.enclosingLoops, [])
    assert.deepEqual(activeMissionCall.enclosingTransactionCallbacks, ["getDb().transaction"])
    const activeMissionTransactionCall = getOnlyCall(activeReceiveBlock, "transaction")
    assert.equal(activeMissionTransactionCall.assignedVariable, "characterList")
    assert.deepEqual(findPropertyAssignmentValues(activeReceiveBlock, "character_list"), ["characterList"])

    const boxCloseBlock = getRouteBlock(boxGachaSource, "/close", "/exec")
    const boxExecBlock = getRouteBlock(boxGachaSource, "/exec", "/get_box_list")
    const boxReadOnlyBlock = getRouteBlock(boxGachaSource, "/get_box_list")
    const boxGachaCall = getOnlyCall(boxExecBlock, "reconcileAwakeUnlockCharacterList")
    assert.equal(findCalls(boxGachaSource, "reconcileAwakeUnlockCharacterList").length, 1)
    assert.deepEqual(boxGachaCall.arguments, ["playerId", "existingCharacterList"])
    assert.equal(boxGachaCall.position > boxExecBlock.indexOf("if (playerBoxData !== null && playerBoxData.isClosed)"), true)
    for (const persistenceCall of [
        "rewardPlayerBoxGachaResultSync",
        "insertPlayerBoxGachaSync",
        "updatePlayerBoxGachaSync",
        "insertPlayerBoxGachaDrawnRewardSync",
        "updatePlayerBoxGachaDrawnRewardSync",
        "updatePlayerItemSync",
    ]) {
        assert.equal(boxGachaCall.position > getLastCallPosition(boxExecBlock, persistenceCall), true)
    }
    assert.deepEqual(boxGachaCall.conditionalConditions, ["settlement.drawnRewards.length > 0"])
    assert.deepEqual(boxGachaCall.enclosingLoops, [])
    assert.deepEqual(findPropertyAssignmentValues(boxExecBlock, "character_list"), ["characterList"])
    assert.equal(findCalls(boxCloseBlock, "reconcileAwakeUnlockCharacterList").length, 0)
    assert.equal(findCalls(boxReadOnlyBlock, "reconcileAwakeUnlockCharacterList").length, 0)

    for (const source of [multiSettlementSource, activeMissionSource, boxGachaSource]) {
        assert.equal(findCalls(source, "settleAwakeMissionRewards").length, 0)
    }
}

testRemainingAuthoritativeMutationRoutesPublishAwakeUnlocks()

function testCharacterGrantRoutesPublishAwakeUnlocks() {
    const gachaSource = readRouteSource("gacha.ts")
    const exchangeSource = readRouteSource("exchange.ts")
    const characterSource = readRouteSource("character.ts")
    const tutorialSource = readRouteSource("tutorial.ts")

    const gachaEquipmentBlock = getRouteBlock(gachaSource, "/exchange_equipment", "/exchange_character")
    const gachaCharacterBlock = getRouteBlock(gachaSource, "/exchange_character", "/exec")
    const gachaExecBlock = getRouteBlock(gachaSource, "/exec")
    assert.equal(findCalls(gachaSource, "reconcileAwakeUnlockCharacterList").length, 2)
    assert.equal(findCalls(gachaEquipmentBlock, "reconcileAwakeUnlockCharacterList").length, 0)

    const gachaExchangeCall = getOnlyCall(gachaCharacterBlock, "reconcileAwakeUnlockCharacterList")
    assert.deepEqual(gachaExchangeCall.arguments, ["playerId", "existingCharacterList"])
    assert.deepEqual(gachaExchangeCall.conditionalConditions, ["existingCharacterList.length > 0"])
    assert.equal(gachaExchangeCall.position > getLastCallPosition(gachaCharacterBlock, "givePlayerCharacterSync"), true)
    assert.equal(gachaExchangeCall.position > getLastCallPosition(gachaCharacterBlock, "updatePlayerGachaInfoSync"), true)
    const gachaExchangeExistingList = findVariableInitializers(gachaCharacterBlock, "existingCharacterList")
    assert.equal(gachaExchangeExistingList.length, 1)
    assert.equal(gachaExchangeExistingList[0].startsWith("giveResult.character"), true)
    assert.equal(gachaExchangeExistingList[0].includes("? [giveResult.character"), true)
    assert.equal(gachaExchangeExistingList[0].endsWith(": []"), true)
    assert.deepEqual(findPropertyAssignmentValues(gachaCharacterBlock, "character_list"), ["characterList"])

    const gachaExecCall = getOnlyCall(gachaExecBlock, "reconcileAwakeUnlockCharacterList")
    assert.deepEqual(gachaExecCall.arguments, ["playerId", "existingCharacterList"])
    assert.deepEqual(gachaExecCall.conditionalConditions, ["existingCharacterList.length > 0"])
    for (const persistenceCall of [
        "rewardPlayerGachaDrawResultSync",
        "insertReceiveHistorySync",
        "insertPlayerGachaInfoSync",
        "updatePlayerGachaInfoSync",
        "updatePlayerSync",
    ]) {
        assert.equal(gachaExecCall.position > getLastCallPosition(gachaExecBlock, persistenceCall), true)
    }
    const gachaExecExistingList = findVariableInitializers(gachaExecBlock, "existingCharacterList")
    assert.equal(gachaExecExistingList.length, 1)
    assert.equal(gachaExecExistingList[0].startsWith("rewardResult.characters.filter("), true)
    assert.equal(gachaExecExistingList[0].includes("character !== undefined"), true)
    assert.equal(gachaExecExistingList[0].includes("character !== null"), true)
    assert.equal(gachaExecExistingList[0].includes('typeof character === "object"'), true)
    assert.equal(gachaExecExistingList[0].includes("!Array.isArray(character)"), true)
    assert.deepEqual(findPropertyAssignmentValues(gachaExecBlock, "character_list"), ["characterList"])

    const starCrumbBlock = getRouteBlock(exchangeSource, "/star_crumb")
    const starCrumbCall = getOnlyCall(starCrumbBlock, "reconcileAwakeUnlockCharacterList")
    assert.equal(findCalls(exchangeSource, "reconcileAwakeUnlockCharacterList").length, 1)
    assert.deepEqual(starCrumbCall.arguments, ["playerId", "characterList"])
    assert.deepEqual(starCrumbCall.conditionalConditions, ["characterList.length > 0"])
    assert.equal(starCrumbCall.position > getLastCallPosition(starCrumbBlock, "givePlayerCharacterSync"), true)
    assert.equal(starCrumbCall.position > getLastCallPosition(starCrumbBlock, "updatePlayerSync"), true)
    assert.equal(starCrumbBlock.includes("if (result.character) characterList.push(result.character"), true)
    assert.deepEqual(findPropertyAssignmentValues(starCrumbBlock, "character_list"), ["characterList"])

    const townReadOnlyBlock = getRouteBlock(characterSource, "/set_illustration_settings", "/over_limit")
    const townOverLimitBlock = getRouteBlock(characterSource, "/over_limit", "/bulk_over_limit")
    const townBulkBlock = getRouteBlock(characterSource, "/bulk_over_limit", "/add_character_from_town")
    const townGrantBlock = getRouteBlock(characterSource, "/add_character_from_town")
    const townCall = getOnlyCall(townGrantBlock, "reconcileAwakeUnlockCharacterList")
    assert.equal(findCalls(characterSource, "reconcileAwakeUnlockCharacterList").length, 1)
    assert.deepEqual(townCall.arguments, ["playerId", "existingCharacterList"])
    assert.deepEqual(townCall.conditionalConditions, ["existingCharacterList.length > 0"])
    assert.equal(townCall.position > getLastCallPosition(townGrantBlock, "givePlayerCharacterSync"), true)
    assert.equal(findCalls(townGrantBlock, "getPlayerCharacterSync").length, 0)
    const townExistingList = findVariableInitializers(townGrantBlock, "existingCharacterList")
    assert.equal(townExistingList.length, 1)
    assert.equal(townExistingList[0].startsWith("giveResult?.character"), true)
    assert.equal(townExistingList[0].includes("? [giveResult.character"), true)
    assert.equal(townExistingList[0].endsWith(": []"), true)
    const townItemList = findVariableInitializers(townGrantBlock, "itemList")
    assert.equal(townItemList.length, 1)
    assert.equal(townItemList[0].startsWith("giveResult?.item"), true)
    assert.equal(townItemList[0].includes("[giveResult.item.id]"), true)
    assert.equal(townItemList[0].includes("giveResult.item.count"), true)
    assert.deepEqual(findPropertyAssignmentValues(townGrantBlock, "character_list"), ["characterList"])
    assert.deepEqual(findPropertyAssignmentValues(townGrantBlock, "item_list"), ["itemList"])
    for (const block of [townReadOnlyBlock, townOverLimitBlock, townBulkBlock]) {
        assert.equal(findCalls(block, "reconcileAwakeUnlockCharacterList").length, 0)
    }

    const tutorialFinishBlock = getRouteBlock(tutorialSource, "/finish_trigger", "/update_step")
    const tutorialUpdateBlock = getRouteBlock(tutorialSource, "/update_step")
    const step15Start = tutorialUpdateBlock.lastIndexOf(
        "if (effectiveNextStep === TUTORIAL_GACHA_EFFECTIVE_STEP)",
    )
    const step16Start = tutorialUpdateBlock.lastIndexOf(
        "if (effectiveNextStep === TUTORIAL_PRESENT_EFFECTIVE_STEP)",
    )
    const otherStepStart = tutorialUpdateBlock.indexOf("const isTutorialEnd", step16Start)
    const tutorialStep15Block = tutorialUpdateBlock.slice(step15Start, step16Start)
    const tutorialStep16Block = tutorialUpdateBlock.slice(step16Start, otherStepStart)
    const tutorialOtherStepBlock = tutorialUpdateBlock.slice(otherStepStart)
    assert.equal(findCalls(tutorialSource, "reconcileAwakeUnlockCharacterList").length, 2)
    assert.equal(findCalls(tutorialFinishBlock, "reconcileAwakeUnlockCharacterList").length, 0)
    assert.equal(findCalls(tutorialOtherStepBlock, "reconcileAwakeUnlockCharacterList").length, 0)

    const tutorialStep15Call = getOnlyCall(tutorialStep15Block, "reconcileAwakeUnlockCharacterList")
    assert.deepEqual(tutorialStep15Call.arguments, ["playerId", "existingCharacterList"])
    assert.deepEqual(tutorialStep15Call.conditionalConditions, ["existingCharacterList.length > 0"])
    assert.equal(tutorialStep15Call.position > getLastCallPosition(tutorialStep15Block, "rewardPlayerGachaDrawResultSync"), true)
    assert.equal(tutorialStep15Call.position > getLastCallPosition(tutorialStep15Block, "insertReceiveHistorySync"), true)
    assert.equal(tutorialStep15Call.position > getLastCallPosition(tutorialStep15Block, "updatePlayerSync"), true)
    const tutorialStep15ExistingList = findVariableInitializers(tutorialStep15Block, "existingCharacterList")
    assert.equal(tutorialStep15ExistingList.length, 1)
    assert.equal(tutorialStep15ExistingList[0].startsWith("rewardResult.characters.filter("), true)
    assert.equal(tutorialStep15ExistingList[0].includes("character !== undefined"), true)
    assert.equal(tutorialStep15ExistingList[0].includes("character !== null"), true)
    assert.equal(tutorialStep15ExistingList[0].includes('typeof character === "object"'), true)
    assert.equal(tutorialStep15ExistingList[0].includes("!Array.isArray(character)"), true)
    assert.deepEqual(findPropertyAssignmentValues(tutorialStep15Block, "character_list"), ["characterList"])

    const tutorialStep16Call = getOnlyCall(tutorialStep16Block, "reconcileAwakeUnlockCharacterList")
    assert.deepEqual(tutorialStep16Call.arguments, ["playerId", "existingCharacterList"])
    assert.deepEqual(tutorialStep16Call.conditionalConditions, ["existingCharacterList.length > 0"])
    assert.equal(tutorialStep16Call.position > getLastCallPosition(tutorialStep16Block, "givePlayerCharacterSync"), true)
    assert.equal(tutorialStep16Call.position > getLastCallPosition(tutorialStep16Block, "insertReceiveHistorySync"), true)
    assert.equal(tutorialStep16Call.position > getLastCallPosition(tutorialStep16Block, "insertMailSync"), true)
    const tutorialStep16ExistingList = findVariableInitializers(tutorialStep16Block, "existingCharacterList")
    assert.equal(tutorialStep16ExistingList.length, 1)
    assert.equal(tutorialStep16ExistingList[0].startsWith("giveResult?.character"), true)
    assert.equal(tutorialStep16ExistingList[0].includes("? [giveResult.character"), true)
    assert.equal(tutorialStep16ExistingList[0].endsWith(": []"), true)
    const tutorialStep16ItemList = findVariableInitializers(tutorialStep16Block, "itemList")
    assert.equal(tutorialStep16ItemList.length, 1)
    assert.equal(tutorialStep16ItemList[0].startsWith("giveResult?.item"), true)
    assert.equal(tutorialStep16ItemList[0].includes("[giveResult.item.id]"), true)
    assert.equal(tutorialStep16ItemList[0].includes("giveResult.item.count"), true)
    assert.deepEqual(findPropertyAssignmentValues(tutorialStep16Block, "character_list"), ["characterList"])
    assert.deepEqual(findPropertyAssignmentValues(tutorialStep16Block, "item_list"), ["itemList"])

    for (const source of [gachaSource, exchangeSource, characterSource, tutorialSource]) {
        assert.equal(findCalls(source, "settleAwakeMissionRewards").length, 0)
        assert.equal(findCalls(source, "givePlayerReward").length, 0)
        assert.equal(findCalls(source, "incrementPlayerCategoryMissionStage").length, 0)
    }
}

testCharacterGrantRoutesPublishAwakeUnlocks()

function testVersion4BackfillValidation() {
    const database = new Database(":memory:")
    database.exec(`
        CREATE TABLE players_characters (
            id INTEGER NOT NULL,
            player_id INTEGER NOT NULL,
            PRIMARY KEY (id, player_id)
        );
        CREATE TABLE players_category_mission_stages (
            category INTEGER NOT NULL,
            id,
            status INTEGER NOT NULL,
            player_id INTEGER NOT NULL,
            mission_id
        );
        CREATE TABLE players_character_awake_unlocks (
            player_id INTEGER NOT NULL,
            character_id INTEGER NOT NULL,
            board_index INTEGER NOT NULL,
            awake_level INTEGER NOT NULL,
            PRIMARY KEY (player_id, character_id, board_index)
        );
    `)
    database.prepare(`
        INSERT INTO players_characters (id, player_id)
        VALUES (341005, 1), (0, 1), (-1, 1), (1, 1)
    `).run()

    const insertReceipt = database.prepare(`
        INSERT INTO players_category_mission_stages
            (category, id, status, player_id, mission_id)
        VALUES (9, ?, 1, 1, ?)
    `)
    for (const [missionId, stageId] of [
        [100, 1], [101, 1], [102, 1], [103, 1], [104, 1], [105, 1],
        [106, 1], [107, 1], [108, 1], [109, 1], [110, 1], [0, 1],
        [-111, 1], [112.5, 1], [113, 0], [114, -1], [115, 1.5],
    ]) {
        insertReceipt.run(stageId, missionId)
    }

    const syntheticRewards = {
        "100": { "1": [["1001", "0", "341005", "1", "1"]] },
        "101": { "1": [["1011", "0", "341006", "2", "1"]] },
        "102": { "1": [["1021", false, "341005", "3", "1"]] },
        "103": { "1": [["1031", 0, "341005", "4", "1"]] },
        "104": { "1": [["1041", "0", "", "5", "1"]] },
        "105": { "1": [["1051", "0", "341005", "", "1"]] },
        "106": { "1": [["1061", "0", "341005", "6", null]] },
        "107": { "1": [["1071", "0", "341005", "-1", "1"]] },
        "108": { "1": [["1081", "0", "341005", "7", "1.5"]] },
        "109": { "1": [["1091", "0", "341005", "8", "NaN"]] },
        "110": { "1": [["1101", "0", "341005", "9007199254740992", "1"]] },
        "": { "1": [["01", "0", "341005", "9", "1"]] },
        "-111": { "1": [["-1111", "0", "341005", "10", "1"]] },
        "112.5": { "1": [["11251", "0", "341005", "11", "1"]] },
        "113": { "": [["1130", "0", "341005", "12", "1"]] },
        "114": { "-1": [["114-1", "0", "341005", "13", "1"]] },
        "115": { "1.5": [["11515", "0", "341005", "14", "1"]] },
    }

    const assetPath = require.resolve("../assets/mission_char_awake_reward.json")
    const updaterPath = require.resolve("../src/data/updaters/wdfpData")
    const originalRewards = require(assetPath)
    require.cache[assetPath].exports = syntheticRewards
    delete require.cache[updaterPath]

    try {
        const { updateAfterInit } = require(updaterPath)
        updateAfterInit(database, 3)
        updateAfterInit(database, 3)

        assert.deepEqual(database.prepare(`
            SELECT player_id, character_id, board_index, awake_level
            FROM players_character_awake_unlocks
            ORDER BY player_id, character_id, board_index
        `).all(), [{
            player_id: 1,
            character_id: 341005,
            board_index: 1,
            awake_level: 1,
        }])
    } finally {
        require.cache[assetPath].exports = originalRewards
        delete require.cache[updaterPath]
        database.close()
    }
}

testVersion4BackfillValidation()

const { getDb } = require("../src/data/db")
const {
    getPlayerCharacterAwakeUnlocksSync,
    upsertPlayerCharacterAwakeUnlockSync,
} = require("../src/data/domains/character_awake")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    insertDefaultPlayerCharacterSync,
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getCharacterDataSync, getCharacterManaNodesSync } = require("../src/lib/assets")
const { characterExpCaps, givePlayerCharacterSync } = require("../src/lib/character")
const {
    createAwakeRequestContext,
    reconcileAwakeUnlockCharacterList,
    reconcileAwakeUnlockCharacterListStrict,
    reconcileAwakeUnlocks,
    reconcileAwakeUnlocksFromProgress,
} = require("../src/lib/mission")
const awakeUnlockModule = require("../src/lib/mission/awake-unlock")
const missionRegistry = require("../src/lib/mission/registry")

require("../src/data").initializeDatabase()
db = getDb()
const idpId = `character-awake-unlock-test-${randomUUID()}`

db.exec("BEGIN")
try {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    insertDefaultPlayerCharacterSync(playerId, 341005)

    db.prepare(`
        DELETE FROM players_category_mission_stages
        WHERE player_id = ? AND category = 9
    `).run(playerId)
    db.prepare(`
        DELETE FROM players_category_missions
        WHERE player_id = ? AND category = 9
    `).run(playerId)
    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ?
    `).run(playerId)
    db.prepare(`
        INSERT INTO players_character_quest_clears (
            player_id, character_id, clear_count, multi_count,
            leader_clear_count, leader_multi_count, leader_power_flip_count
        ) VALUES (?, 341005, 5, 0, 0, 0, 0)
        ON CONFLICT(player_id, character_id) DO UPDATE SET clear_count = 5
    `).run(playerId)

    db.prepare(`
        DELETE FROM players_characters
        WHERE player_id = ? AND id = 341005
    `).run(playerId)
    const ownershipItemAmountsBefore = Object.fromEntries(
        [13, 14, 15, 16].map(itemId => [itemId, getPlayerItemSync(playerId, itemId) ?? 0])
    )
    const beforeOwnership = reconcileAwakeUnlocks(playerId, [341005])
    assert.equal(beforeOwnership.changed.size, 0)
    assert.equal(beforeOwnership.all.size, 0)

    const ownershipGrant = givePlayerCharacterSync(playerId, 341005)
    assert.notEqual(ownershipGrant, null)
    const rarity = getCharacterDataSync(341005).rarity
    updatePlayerCharacterSync(playerId, 341005, { exp: characterExpCaps[rarity][0] })
    insertPlayerCharacterManaNodesSync(
        playerId,
        341005,
        Object.keys(getCharacterManaNodesSync(341005, 1)).map(Number),
    )
    const afterOwnershipCharacterList = reconcileAwakeUnlockCharacterList(
        playerId,
        ownershipGrant.character ? [ownershipGrant.character] : []
    )
    assert.equal(afterOwnershipCharacterList.length, 1)
    assert.equal(afterOwnershipCharacterList[0].character_id, 341005)
    assert.deepEqual(afterOwnershipCharacterList[0].mana_board_awake, { 1: 1 })
    assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("341005"), { 1: 1 })
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_category_missions
        WHERE player_id = ? AND category = 9
    `).get(playerId).count, 0)
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_category_mission_stages
        WHERE player_id = ? AND category = 9
    `).get(playerId).count, 0)
    assert.deepEqual(
        Object.fromEntries([13, 14, 15, 16].map(itemId => [itemId, getPlayerItemSync(playerId, itemId) ?? 0])),
        ownershipItemAmountsBefore
    )

    const firstDuplicateGrant = givePlayerCharacterSync(playerId, 341005)
    assert.notEqual(firstDuplicateGrant, null)
    assert.equal(firstDuplicateGrant.character.stack, 1)
    assert.notEqual(firstDuplicateGrant.item, undefined)
    const duplicateItemId = firstDuplicateGrant.item.id
    const itemCountAfterFirstDuplicate = getPlayerItemSync(playerId, duplicateItemId)

    const secondDuplicateGrant = givePlayerCharacterSync(playerId, 341005)
    assert.notEqual(secondDuplicateGrant, null)
    assert.equal(secondDuplicateGrant.character.stack, 2)
    assert.equal(secondDuplicateGrant.item.id, duplicateItemId)
    assert.equal(
        getPlayerItemSync(playerId, duplicateItemId),
        itemCountAfterFirstDuplicate + secondDuplicateGrant.item.count
    )

    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ?
    `).run(playerId)

    assert.equal(upsertPlayerCharacterAwakeUnlockSync(playerId, 341005, 1, 1), true)
    const originalGetComputer = missionRegistry.getComputer
    missionRegistry.getComputer = () => {
        throw new Error("candidate=[] must not build a mission context")
    }
    try {
        const emptyCandidateReconciliation = reconcileAwakeUnlocks(playerId, [])
        assert.deepEqual(emptyCandidateReconciliation.all, new Map([["341005", { 1: 1 }]]))
        assert.equal(emptyCandidateReconciliation.changed.size, 0)
    } finally {
        missionRegistry.getComputer = originalGetComputer
    }
    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ?
    `).run(playerId)

    assert.equal(typeof reconcileAwakeUnlocksFromProgress, "function")
    const authoritativeProgress = [
        { missionId: 3410051, progress: 1 },
        { missionId: 3410052, progress: 5 },
        { missionId: 3410053, progress: 5 },
        { missionId: 3410054, progress: 3 },
    ]
    const expectedUnlocks = new Map([["341005", { 1: 1 }]])
    const originalGetComputerForProgress = missionRegistry.getComputer
    missionRegistry.getComputer = () => {
        throw new Error("fromProgress must not build a mission context")
    }
    try {
        const emptyProgressReconciliation = reconcileAwakeUnlocksFromProgress(playerId, [])
        assert.equal(emptyProgressReconciliation.changed.size, 0)
        assert.equal(emptyProgressReconciliation.all.size, 0)

        const fromProgressReconciliation = reconcileAwakeUnlocksFromProgress(playerId, authoritativeProgress)
        assert.deepEqual(fromProgressReconciliation.changed, expectedUnlocks)
        assert.deepEqual(fromProgressReconciliation.all, expectedUnlocks)

        const repeatedProgressReconciliation = reconcileAwakeUnlocksFromProgress(playerId, authoritativeProgress)
        assert.equal(repeatedProgressReconciliation.changed.size, 0)
        assert.deepEqual(repeatedProgressReconciliation.all, expectedUnlocks)
    } finally {
        missionRegistry.getComputer = originalGetComputerForProgress
    }

    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ?
    `).run(playerId)

    const itemAmountsBefore = Object.fromEntries(
        [13, 14, 15, 16].map(itemId => [itemId, getPlayerItemSync(playerId, itemId) ?? 0])
    )
    const firstReconciliation = reconcileAwakeUnlocks(playerId, [341005])

    assert.deepEqual(firstReconciliation.changed, expectedUnlocks)
    assert.deepEqual(firstReconciliation.all, expectedUnlocks)
    assert.equal(firstReconciliation.changed.has("341006"), false)
    assert.equal(firstReconciliation.all.size, 1)
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_category_missions
        WHERE player_id = ? AND category = 9
    `).get(playerId).count, 0)
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_category_mission_stages
        WHERE player_id = ? AND category = 9
    `).get(playerId).count, 0)
    assert.deepEqual(
        Object.fromEntries([13, 14, 15, 16].map(itemId => [itemId, getPlayerItemSync(playerId, itemId) ?? 0])),
        itemAmountsBefore
    )

    const secondReconciliation = reconcileAwakeUnlocks(playerId, [341005])
    assert.equal(secondReconciliation.changed.size, 0)
    assert.deepEqual(secondReconciliation.all, expectedUnlocks)

    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ?
    `).run(playerId)
    const fullReconciliation = reconcileAwakeUnlocks(playerId)
    assert.deepEqual(fullReconciliation.changed, expectedUnlocks)
    assert.deepEqual(fullReconciliation.all, expectedUnlocks)

    const compatibilityContext = createAwakeRequestContext({
        playerId,
        evaluationTime: new Date("2025-01-01T12:00:00.000Z"),
        candidateCharacterIds: [341005],
    })
    const strictCharacterList = reconcileAwakeUnlockCharacterListStrict(
        playerId,
        [],
        {
            candidateCharacterIds: [341005],
            context: compatibilityContext,
        },
    )
    assert.equal(strictCharacterList.length, 0)
    const compatibilityReconciliation = reconcileAwakeUnlocks(
        playerId,
        [341005],
        compatibilityContext,
    )
    assert.notStrictEqual(compatibilityReconciliation.all, compatibilityContext.readUnlocks())
    assert.deepEqual(compatibilityReconciliation.all, compatibilityContext.readUnlocks())

    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ? AND character_id = 341005
    `).run(playerId)

    assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has("341005"), false)
    assert.equal(upsertPlayerCharacterAwakeUnlockSync(playerId, 341005, 1, 1), true)
    assert.equal(upsertPlayerCharacterAwakeUnlockSync(playerId, 341005, 1, 0), false)
    assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("341005"), { 1: 1 })
    assert.equal(upsertPlayerCharacterAwakeUnlockSync(playerId, 341005, 1, 2), true)
    assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("341005"), { 1: 2 })

    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ? AND character_id = 341005
    `).run(playerId)
    assert.equal(db.prepare(`
        SELECT clear_count
        FROM players_character_quest_clears
        WHERE player_id = ? AND character_id = 341005
    `).get(playerId).clear_count, 5)

    const endpointBondTokenList = [{ mana_board_index: 2, status: 1 }]
    const existingCharacterList = [{
        character_id: 341005,
        exp: 123,
        bond_token_list: endpointBondTokenList,
        mana_board_awake: {
            1: 0,
            2: 1,
            4: "invalid",
            5: Number.NaN,
            6: Number.POSITIVE_INFINITY,
            7: -1,
            8: 1.5,
            0: 1,
            "-1": 1,
            invalid: 1,
        },
    }, {
        character_id: 341005,
        exp: 999,
        stack: 7,
        update_time: "newer-endpoint-value",
        mana_board_awake: { 2: 2, 3: 1, 4: 2 },
    }]
    const mergedCharacterList = reconcileAwakeUnlockCharacterList(playerId, existingCharacterList)
    const mergedMew = mergedCharacterList.find(entry => entry.character_id === 341005)
    assert.equal(mergedCharacterList.filter(entry => entry.character_id === 341005).length, 1)
    assert.equal(mergedMew.exp, 999)
    assert.equal(mergedMew.stack, 7)
    assert.equal(mergedMew.update_time, "newer-endpoint-value")
    assert.strictEqual(mergedMew.bond_token_list, endpointBondTokenList)
    assert.deepEqual(mergedMew.mana_board_awake, { 1: 1, 2: 2, 3: 1, 4: 2 })

    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ? AND character_id = 341005
    `).run(playerId)
    const appendedCharacterList = reconcileAwakeUnlockCharacterList(playerId, [])
    assert.equal(appendedCharacterList.length, 1)
    assert.equal(appendedCharacterList[0].character_id, 341005)
    assert.equal(typeof appendedCharacterList[0].join_time, "string")
    assert.equal(typeof appendedCharacterList[0].update_time, "string")
    assert.deepEqual(appendedCharacterList[0].mana_board_awake, { 1: 1 })

    const unchangedBondTokenList = [{ mana_board_index: 2, status: 1 }]
    const unchangedCharacterList = [{
        character_id: 341005,
        exp: 1,
        bond_token_list: unchangedBondTokenList,
        mana_board_awake: { 1: 1, 2: 1 },
    }, {
        character_id: 341005,
        exp: 2,
        stack: 3,
        update_time: "latest-response-value",
        mana_board_awake: { 2: 2, 3: 1 },
    }]
    const unchangedCharacterListSnapshot = structuredClone(unchangedCharacterList)
    const deduplicatedCharacterList = reconcileAwakeUnlockCharacterList(
        playerId,
        unchangedCharacterList,
    )
    assert.notStrictEqual(deduplicatedCharacterList, unchangedCharacterList)
    assert.deepEqual(deduplicatedCharacterList, [{
        character_id: 341005,
        exp: 2,
        bond_token_list: unchangedBondTokenList,
        mana_board_awake: { 1: 1, 2: 2, 3: 1 },
        stack: 3,
        update_time: "latest-response-value",
    }])
    assert.strictEqual(deduplicatedCharacterList[0].bond_token_list, unchangedBondTokenList)
    assert.deepEqual(unchangedCharacterList, unchangedCharacterListSnapshot)

    const fallbackExistingCharacterList = [{ character_id: 341005, stack: 2 }]
    const fallbackError = new Error("synthetic awake unlock reconciliation failure")
    const fallbackItemAmountsBefore = Object.fromEntries(
        [13, 14, 15, 16].map(itemId => [itemId, getPlayerItemSync(playerId, itemId) ?? 0])
    )
    const originalReconcileAwakeUnlocks = awakeUnlockModule.reconcileAwakeUnlocks
    const originalConsoleError = console.error
    let loggedFallbackError = null
    awakeUnlockModule.reconcileAwakeUnlocks = () => {
        throw fallbackError
    }
    console.error = (...args) => {
        loggedFallbackError = args
    }
    try {
        assert.strictEqual(
            reconcileAwakeUnlockCharacterList(playerId, fallbackExistingCharacterList),
            fallbackExistingCharacterList
        )
        assert.deepEqual(loggedFallbackError, [
            "[awake-unlock] Failed to publish character unlocks.",
            fallbackError,
        ])
    } finally {
        console.error = originalConsoleError
        awakeUnlockModule.reconcileAwakeUnlocks = originalReconcileAwakeUnlocks
    }
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_category_missions
        WHERE player_id = ? AND category = 9
    `).get(playerId).count, 0)
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_category_mission_stages
        WHERE player_id = ? AND category = 9
    `).get(playerId).count, 0)
    assert.deepEqual(
        Object.fromEntries([13, 14, 15, 16].map(itemId => [itemId, getPlayerItemSync(playerId, itemId) ?? 0])),
        fallbackItemAmountsBefore
    )

    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ? AND character_id = 341005
    `).run(playerId)
    awakeUnlockModule.reconcileAwakeUnlocks = () => ({
        all: new Map(),
        changed: new Map([
            ["341006", { 1: 1 }],
            ["999999", { 1: 1 }],
        ]),
        removed: new Map(),
    })
    try {
        assert.deepEqual(reconcileAwakeUnlockCharacterList(playerId, []), [])
    } finally {
        awakeUnlockModule.reconcileAwakeUnlocks = originalReconcileAwakeUnlocks
    }

    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_category_missions
        WHERE player_id = ? AND category = 9
    `).get(playerId).count, 0)
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_category_mission_stages
        WHERE player_id = ? AND category = 9
    `).get(playerId).count, 0)
    assert.deepEqual(
        Object.fromEntries([13, 14, 15, 16].map(itemId => [itemId, getPlayerItemSync(playerId, itemId) ?? 0])),
        itemAmountsBefore
    )

    console.log("character awake unlock tests passed")
} finally {
    db.exec("ROLLBACK")
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM accounts
        WHERE idp_id = ?
    `).get(idpId).count, 0)
}
cleanupDatabase()
process.removeListener("exit", cleanupDatabase)
