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
    ["publishCharacterGrowthOwnerStateBestEffort", "best-effort"],
    ["publishAwakeUnlockCharacterListWithinTransaction", "growth-facts-in-tx"],
    ["publishAwakeUnlockCharacterListWithStateWithinTransaction", "growth-facts-in-tx"],
])
const AWAKE_CALLEE_PREFIX = "reconcileAwakeUnlockCharacterList"
const SINGLE_AWAKE_WRAPPER = "publishAwakeCharacterListBestEffort"
const GROWTH_AWAKE_WRAPPER = "publishCharacterGrowthOwnerStateBestEffort"
const GROWTH_AWAKE_FACT_WRITERS = new Set([
    "publishAwakeUnlockCharacterListWithinTransaction",
    "publishAwakeUnlockCharacterListWithStateWithinTransaction",
])
const PLANNED_CANDIDATE_SOURCES = Object.freeze({
    "single/finish": "battle-party+invalidated-facts",
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
const AUTHORITATIVE_WRITE_SETS = Object.freeze({
    "single/finish": Object.freeze([
        "updatePlayerQuestProgressSync", "insertPlayerQuestProgressSync", "updatePlayerSync",
        "setPlayerState", "grantDirectRewards", "settleSingleEntryResources",
        "grantSingleSettlementScoreRewardsWithinTransactionSync", "settleAdditionalRewardsSync",
        "recordMissionBattleFacts", "givePlayerCharactersExpSync", "handleRushEventFinish",
        "dispatchModeRushFinish", "handleRaidEventFinish", "handleCarnivalEventFinish",
        "insertPlayerScoreAttackBattleHistorySync", "insertPlayerPracticeBattleHistorySync",
        "handleScoreAttackEventFinish", "settleSingleMissionEvaluations", "setExpPool",
        "observeGrant", "observeItems", "observeResult", "finalize",
        "finalizeSingleAwakePublicationWrites",
    ]),
    "multi/finish": Object.freeze([
        "givePlayerRewardSync", "updatePlayerQuestProgressSync", "insertPlayerQuestProgressSync",
        "updatePlayerSync", "givePlayerScoreRewardsSync", "settleAdditionalRewardsSync",
        "settleRescueFragmentReward", "settleActivityPeriodicRewardsSync", "recordMissionBattleFacts",
        "givePlayerCharactersExpSync", "settleMissionCategoriesWithEvaluation",
        "settleAwakeMissionCandidatesWithEvaluation", "finalizeMultiAwakePublicationWrites",
    ]),
    "active_mission/receive": Object.freeze([
        "updatePlayerActiveMissionStageSync", "grant", "persistPlayer",
    ]),
    "box_gacha/exec": Object.freeze(["transaction"]),
    "character/add_character_from_town": Object.freeze(["transaction"]),
    "character/receive_bond_token": Object.freeze(["receiveBondToken"]),
    "character/learn_mana_node": Object.freeze([
        "updatePlayerSync", "incrementActiveMissionUsedManaCountSync",
        "setPlayerItemWithinTransactionSync", "insertPlayerCharacterManaNodesSync",
        "updateBondTokenForCompletedBoardFromGrowthState", "finalizeLearnManaAwakePublicationWrites",
    ]),
    "exchange/star_crumb": Object.freeze(["transaction"]),
    "gacha/exchange_character": Object.freeze(["transaction"]),
    "gacha/exec": Object.freeze(["transaction"]),
    "item/sell": Object.freeze(["sellItemSync"]),
    "mail/receive": Object.freeze([
        "settleMailRewardsInTransactionOwnerSync", "finalizeMailReceiveAwakePublicationWrites",
    ]),
    "mail/receive_all": Object.freeze([
        "settleMailRewardsInTransactionOwnerSync", "finalizeMailReceiveAllAwakePublicationWrites",
    ]),
    "mission/update_mission_progress": Object.freeze(["transaction"]),
    "pass_card/receive_all": Object.freeze(["transaction"]),
    "raid_event/summary": Object.freeze(["transaction"]),
    "shop/buy": Object.freeze(["executeGenericShopPurchaseSync"]),
    "shop/bulk_buy": Object.freeze(["executeGenericShopBatchPurchaseSync"]),
    "story_quest/finish": Object.freeze([
        "givePlayerRewardSync", "givePlayerCharacterSync", "insertPlayerQuestProgressSync",
        "updatePlayerQuestProgressSync", "reconcileActiveMissionFacts",
    ]),
    "tutorial/update_step:15": Object.freeze([
        "rewardPlayerGachaDrawResultSync", "executeRewardGrantPlanInTransactionOwnerInternalSync",
        "insertReceiveHistorySync", "updatePlayerSync",
    ]),
    "tutorial/update_step:16": Object.freeze([
        "givePlayerCharacterSync", "insertMailSync", "updatePlayerSync",
    ]),
})
const OWNER_TRANSACTION_ANCHORS = Object.freeze({
    "box_gacha/exec": "transaction",
    "exchange/star_crumb": "transaction",
    "gacha/exchange_character": "transaction",
    "shop/buy": "executeGenericShopPurchaseSync",
    "shop/bulk_buy": "executeGenericShopBatchPurchaseSync",
})
const TUTORIAL_OWNER_SCOPE_CONTRACTS = Object.freeze({
    "tutorial/update_step:15": Object.freeze({
        constantName: "TUTORIAL_GACHA_EFFECTIVE_STEP",
        literal: 15,
    }),
    "tutorial/update_step:16": Object.freeze({
        constantName: "TUTORIAL_PRESENT_EFFECTIVE_STEP",
        literal: 16,
    }),
})
const SINGLE_SYNC_AUTHORITATIVE_CALLBACKS = Object.freeze({
    grantRewards: Object.freeze(["grantDirectRewards"]),
    giveRewards: Object.freeze(["grantDirectRewards"]),
    updateProgress: Object.freeze(["updatePlayerQuestProgressSync"]),
    insertProgress: Object.freeze(["insertPlayerQuestProgressSync"]),
})
const TUTORIAL_STEP_15_SYNC_AUTHORITATIVE_CALLBACKS = Object.freeze({
    ownerGrant: Object.freeze(["executeRewardGrantPlanInTransactionOwnerInternalSync"]),
})
const FINAL_WRITE_HELPERS = Object.freeze({
    "single/finish": Object.freeze({
        helperName: "finalizeSingleAwakePublicationWrites",
        callInventory: Object.freeze([
            "import:../../../data/domains/quest_active#deletePlayerActiveQuestSync=1",
        ]),
        executionInventory: Object.freeze([
            "sync:import:../../../data/domains/quest_active#deletePlayerActiveQuestSync=1",
        ]),
        internalWrites: Object.freeze([
            Object.freeze({ kind: "import", name: "deletePlayerActiveQuestSync" }),
        ]),
    }),
    "multi/finish": Object.freeze({
        helperName: "finalizeMultiAwakePublicationWrites",
        callInventory: Object.freeze(["parameter:deleteActiveQuest=1"]),
        executionInventory: Object.freeze(["sync:parameter:deleteActiveQuest=1"]),
        internalWrites: Object.freeze([
            Object.freeze({ kind: "parameter", name: "deleteActiveQuest" }),
        ]),
    }),
    "character/learn_mana_node": Object.freeze({
        helperName: "finalizeLearnManaAwakePublicationWrites",
        callInventory: Object.freeze([
            "import:../../../data/domains/character#updatePlayerCharacterSync=1",
        ]),
        executionInventory: Object.freeze([
            "sync:import:../../../data/domains/character#updatePlayerCharacterSync=1",
        ]),
        internalWrites: Object.freeze([
            Object.freeze({ kind: "import", name: "updatePlayerCharacterSync" }),
        ]),
    }),
    "mail/receive": Object.freeze({
        helperName: "finalizeMailReceiveAwakePublicationWrites",
        callInventory: Object.freeze([
            "import:../../data/domains/mail#receiveMailSync=1",
        ]),
        executionInventory: Object.freeze([
            "sync:import:../../data/domains/mail#receiveMailSync=1",
        ]),
        internalWrites: Object.freeze([
            Object.freeze({ kind: "import", name: "receiveMailSync" }),
        ]),
    }),
    "mail/receive_all": Object.freeze({
        helperName: "finalizeMailReceiveAllAwakePublicationWrites",
        callInventory: Object.freeze([
            "import:../../data/domains/mail#receiveMailSync=1",
            "member:claimed#push=1",
            "member:mailMap#get=1",
        ]),
        executionInventory: Object.freeze([
            "sync:import:../../data/domains/mail#receiveMailSync=1",
            "sync:member:claimed#push=1",
            "sync:member:mailMap#get=1",
        ]),
        internalWrites: Object.freeze([
            Object.freeze({ kind: "import", name: "receiveMailSync" }),
        ]),
    }),
})
const OWNER_CALL_INVENTORIES = require("./awake_reconcile_owner_call_inventory.json")
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
    "authoritativeWriteSet",
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
        authoritativeWriteSet: AUTHORITATIVE_WRITE_SETS[owner],
        finalWriteRule: OWNER_TRANSACTION_ANCHORS[owner] === undefined
            ? "same-block-direct"
            : "owner-transaction-statement",
        snapshotSource: "none",
        rereadReason,
        sqlUpperBoundKey: runtimeEvidenceKey,
        runtimeEvidenceKey,
        changesGlobalFacts,
    })
}

const EXPECTED_MATRIX = Object.freeze([
    matrixRow({ relativeFile: "src/lib/character-growth/commands/learn-mana-nodes.ts", callee: "growth-facts-in-tx", owner: "character/learn_mana_node", boundary: "strict-in-tx", actualCharacterSeed: "[command.characterId]", finalAuthoritativeWrite: "finalizeLearnManaAwakePublicationWrites", runtimeEvidenceKey: "learn-mana-final-node" }),
    matrixRow({ relativeFile: "src/lib/quest/finish/single-settlement-writes.ts", owner: "single/finish", boundary: "best-effort-in-tx", actualCharacterSeed: "partyCharacterIds", actualFactSeeds: "awakePublication.invalidatedFactKeys", directMissionSeed: "awakePublication.directMissionIds", finalAuthoritativeWrite: "finalizeSingleAwakePublicationWrites", runtimeEvidenceKey: "single-finish", changesGlobalFacts: true, rereadReason: SINGLE_REREAD_REASON }),
    matrixRow({ relativeFile: "src/multi/settlement/orchestrator.ts", owner: "multi/finish", boundary: "best-effort-in-tx", actualCharacterSeed: "candidateCharacterIds", actualFactSeeds: "invalidatedFactKeys", directMissionSeed: "[ ...missionBattleFacts.awakeMissionIds, ...(awakeMissionEvaluation?.evaluation.missions.map(mission => mission.missionId) ?? []), ]", finalAuthoritativeWrite: "finalizeMultiAwakePublicationWrites", runtimeEvidenceKey: "multi-finish", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/activeMission.ts", owner: "active_mission/receive", boundary: "best-effort-in-tx", actualCharacterSeed: "[]", actualFactSeeds: "granter.invalidatedFactKeys", finalAuthoritativeWrite: "persistPlayer", runtimeEvidenceKey: "active-mission-receive", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/boxGacha.ts", owner: "box_gacha/exec", boundary: "best-effort-post-commit", actualCharacterSeed: "settlement.rewardResult?.joined_character_id_list ?? []", actualFactSeeds: "reward-result", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "box-gacha-exec", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/character.ts", owner: "character/add_character_from_town", boundary: "best-effort-post-commit", actualCharacterSeed: "[characterId]", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "character-town-grant" }),
    matrixRow({ relativeFile: "src/routes/api/character/bond.ts", owner: "character/receive_bond_token", boundary: "best-effort-in-tx", actualCharacterSeed: "[body.character_id]", finalAuthoritativeWrite: "receiveBondToken", runtimeEvidenceKey: "bond-success" }),
    matrixRow({ relativeFile: "src/routes/api/exchange.ts", owner: "exchange/star_crumb", boundary: "best-effort-post-commit", actualCharacterSeed: "kind === 0 ? [targetId] : []", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "exchange-star-crumb" }),
    matrixRow({ relativeFile: "src/routes/api/gacha.ts", owner: "gacha/exchange_character", boundary: "best-effort-post-commit", actualCharacterSeed: "[characterId]", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "gacha-exchange-character" }),
    matrixRow({ relativeFile: "src/routes/api/gacha.ts", owner: "gacha/exec", boundary: "best-effort-post-commit", actualCharacterSeed: "[]", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "gacha-exec" }),
    matrixRow({ relativeFile: "src/routes/api/item.ts", owner: "item/sell", boundary: "best-effort-post-commit", actualCharacterSeed: "[]", actualFactSeeds: "player", finalAuthoritativeWrite: "sellItemSync", runtimeEvidenceKey: "mana-item-sell", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/mail.ts", owner: "mail/receive", boundary: "best-effort-in-tx", actualCharacterSeed: "[]", actualFactSeeds: "mail", finalAuthoritativeWrite: "finalizeMailReceiveAwakePublicationWrites", runtimeEvidenceKey: "mail-receive", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/mail.ts", owner: "mail/receive_all", boundary: "best-effort-in-tx", actualCharacterSeed: "[]", actualFactSeeds: "mail", finalAuthoritativeWrite: "finalizeMailReceiveAllAwakePublicationWrites", runtimeEvidenceKey: "mail-receive-all", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/mission.ts", owner: "mission/update_mission_progress", boundary: "best-effort-post-commit", actualCharacterSeed: "awakeCandidateCharacterIds", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "category9-update-progress" }),
    matrixRow({ relativeFile: "src/routes/api/passCard.ts", owner: "pass_card/receive_all", boundary: "best-effort-post-commit", actualCharacterSeed: "[]", actualFactSeeds: "result.invalidatedFactKeys", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "pass-card-receive-all", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/raidEvent.ts", owner: "raid_event/summary", boundary: "best-effort-post-commit", actualCharacterSeed: "[]", actualFactSeeds: "reward-result", finalAuthoritativeWrite: "transaction", runtimeEvidenceKey: "raid-event-summary", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/shop.ts", owner: "shop/buy", boundary: "best-effort-post-commit", actualCharacterSeed: "rewardResult.joined_character_id_list ?? []", actualFactSeeds: "reward-result", finalAuthoritativeWrite: "executeGenericShopPurchaseSync", runtimeEvidenceKey: "shop-buy", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/shop.ts", owner: "shop/bulk_buy", boundary: "best-effort-post-commit", actualCharacterSeed: "rewardResult.joined_character_id_list ?? []", actualFactSeeds: "reward-result", finalAuthoritativeWrite: "executeGenericShopBatchPurchaseSync", runtimeEvidenceKey: "shop-bulk-buy", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/storyQuest.ts", owner: "story_quest/finish", boundary: "best-effort-in-tx", actualCharacterSeed: "storyCandidateCharacterIds", actualFactSeeds: "story-reward+quest-progress", finalAuthoritativeWrite: "reconcileActiveMissionFacts", runtimeEvidenceKey: "story-finish", changesGlobalFacts: true }),
    matrixRow({ relativeFile: "src/routes/api/tutorial.ts", owner: "tutorial/update_step:15", boundary: "best-effort-in-tx", actualCharacterSeed: "[randomCharacterId]", finalAuthoritativeWrite: "updatePlayerSync", runtimeEvidenceKey: "tutorial-step-15" }),
    matrixRow({ relativeFile: "src/routes/api/tutorial.ts", owner: "tutorial/update_step:16", boundary: "best-effort-in-tx", actualCharacterSeed: "[freeTutorialCharacterId]", finalAuthoritativeWrite: "updatePlayerSync", runtimeEvidenceKey: "tutorial-step-16" }),
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
                    && exportedName !== SINGLE_AWAKE_WRAPPER
                    && exportedName !== GROWTH_AWAKE_WRAPPER
                    && !GROWTH_AWAKE_FACT_WRITERS.has(exportedName)) continue
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
                if (name.startsWith(AWAKE_CALLEE_PREFIX)
                    || name === SINGLE_AWAKE_WRAPPER
                    || name === GROWTH_AWAKE_WRAPPER
                    || GROWTH_AWAKE_FACT_WRITERS.has(name)) {
                    exportedName = name
                    moduleSpecifier = namespaceSpecifier
                }
            }
            if (exportedName !== null) {
                if (exportedName === SINGLE_AWAKE_WRAPPER
                    && !moduleSpecifier.endsWith("/awake-best-effort-context")) {
                    throw new Error(`${fileName} single Awake wrapper import must use awake-best-effort-context`)
                }
                if (exportedName === GROWTH_AWAKE_WRAPPER
                    && !moduleSpecifier.endsWith("/character-growth/owner-publication")) {
                    throw new Error(`${fileName} Growth owner wrapper import must use character-growth/owner-publication`)
                }
                if (GROWTH_AWAKE_FACT_WRITERS.has(exportedName)
                    && !moduleSpecifier.endsWith("/character-growth/facts/awake-unlock-facts")
                    && !moduleSpecifier.endsWith("/facts/awake-unlock-facts")) {
                    throw new Error(`${fileName} Growth fact writer import must use character-growth/facts/awake-unlock-facts`)
                }
                if (exportedName !== SINGLE_AWAKE_WRAPPER
                    && exportedName !== GROWTH_AWAKE_WRAPPER
                    && !GROWTH_AWAKE_FACT_WRITERS.has(exportedName)
                    && !isMissionModuleSpecifier(moduleSpecifier)) {
                    ts.forEachChild(node, visit)
                    return
                }
                const callee = CALLEES.get(exportedName)
                if (callee === undefined) {
                    throw new Error(`${fileName} calls unknown Awake publication helper ${exportedName}`)
                }
                calls.push({ callee, call: node, checker, exportedName, moduleSpecifier, sourceFile })
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

function classifyOwner(relativeFile, call, sourceFile, checker) {
    if (relativeFile === "src/lib/character-growth/commands/learn-mana-nodes.ts") {
        return "character/learn_mana_node"
    }
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
        const owners = Object.keys(TUTORIAL_OWNER_SCOPE_CONTRACTS).filter(owner => (
            findTutorialOwnerBranch(call, owner, checker, false) !== null
        ))
        assert.equal(owners.length, 1, "tutorial Awake publication left its exact audited step branch")
        return owners[0]
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

function findNamedFunctionDeclaration(sourceFile, name) {
    const declarations = []
    function visit(node) {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) declarations.push(node)
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    assert.equal(
        declarations.length,
        1,
        `${sourceFile.fileName} must declare final-write helper ${name} exactly once`,
    )
    return declarations[0]
}

function nonImmediateFunctionAncestors(node, root) {
    const ancestors = []
    for (let current = node.parent; current && current !== root; current = current.parent) {
        if (ts.isFunctionLike(current) && !isImmediatelyInvokedFunction(current)) {
            ancestors.push(current)
        }
    }
    return ancestors
}

function collectHelperExecutionInventory(helper, checker, sourceFile) {
    const counts = new Map()
    function visit(node) {
        if (ts.isCallExpression(node)) {
            const execution = nonImmediateFunctionAncestors(node, helper).length === 0
                ? "sync"
                : "deferred"
            const key = `${execution}:${callExpressionIdentity(node, checker, sourceFile)}`
            counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        ts.forEachChild(node, visit)
    }
    visit(helper)
    return [...counts].sort(([left], [right]) => left.localeCompare(right))
        .map(([identity, count]) => `${identity}=${count}`)
}

function assertFinalWriteHelperOwnershipInSource(sourceFile, checker, ownerRoot, contract) {
    const helper = findNamedFunctionDeclaration(sourceFile, contract.helperName)
    const helperSymbol = checker.getSymbolAtLocation(helper.name)
    assert.notEqual(helperSymbol, undefined, `${contract.helperName} helper symbol is missing`)
    assert.equal(
        collectCallsForSymbol(ownerRoot, checker, helperSymbol).length,
        1,
        `${sourceFile.fileName} owner must call ${contract.helperName} exactly once`,
    )
    assert.deepEqual(
        collectOwnerCallInventory(helper, checker, sourceFile),
        contract.callInventory,
        `${contract.helperName} helper complete call inventory contains an unreviewed call`,
    )
    assert.deepEqual(
        collectHelperExecutionInventory(helper, checker, sourceFile),
        contract.executionInventory,
        `${contract.helperName} helper execution inventory contains an unreviewed sync/deferred role`,
    )
    for (const write of contract.internalWrites) {
        let writeSymbol
        if (write.kind === "import") {
            writeSymbol = findNamedImportSymbol(
                sourceFile,
                checker,
                write.name,
                () => true,
            )
        } else {
            const parameters = helper.parameters.filter(parameter => (
                ts.isIdentifier(parameter.name) && parameter.name.text === write.name
            ))
            assert.equal(
                parameters.length,
                1,
                `${contract.helperName} must own parameter ${write.name} exactly once`,
            )
            writeSymbol = checker.getSymbolAtLocation(parameters[0].name)
        }
        assert.notEqual(writeSymbol, undefined, `${contract.helperName}.${write.name} symbol is missing`)
        const writeCalls = collectCallsForSymbol(helper, checker, writeSymbol)
        assert.equal(
            writeCalls.length,
            1,
            `${contract.helperName} must call owned ${write.kind} ${write.name} exactly once`,
        )
        assert.equal(
            nonImmediateFunctionAncestors(writeCalls[0], helper).length,
            0,
            `${contract.helperName} helper authoritative write ${write.name} must be synchronous, not deferred in a nested non-IIFE function`,
        )
    }
}

function assertFinalWriteHelperOwnership(source, fileName, contract) {
    const { checker, sourceFile } = createTypeCheckedSource(source, fileName)
    const ownerRoot = findExportedFunctionDeclaration(
        sourceFile,
        checker,
        contract.ownerFunctionName,
    )
    assertFinalWriteHelperOwnershipInSource(sourceFile, checker, ownerRoot, contract)
}

function findAncestor(node, predicate) {
    for (let current = node; current; current = current.parent) {
        if (predicate(current)) return current
    }
    return null
}

function importIdentity(symbol) {
    for (const declaration of symbol?.getDeclarations() ?? []) {
        if (!ts.isImportSpecifier(declaration)) continue
        const importDeclaration = findAncestor(declaration, ts.isImportDeclaration)
        if (!importDeclaration || !ts.isStringLiteral(importDeclaration.moduleSpecifier)) continue
        return `import:${importDeclaration.moduleSpecifier.text}#${
            declaration.propertyName?.text ?? declaration.name.text
        }`
    }
    return null
}

function namespaceImportModule(symbol) {
    for (const declaration of symbol?.getDeclarations() ?? []) {
        if (!ts.isNamespaceImport(declaration)) continue
        const importDeclaration = findAncestor(declaration, ts.isImportDeclaration)
        if (importDeclaration && ts.isStringLiteral(importDeclaration.moduleSpecifier)) {
            return importDeclaration.moduleSpecifier.text
        }
    }
    return null
}

function identifierCallIdentity(identifier, checker) {
    const symbol = checker.getSymbolAtLocation(identifier)
    const imported = importIdentity(symbol)
    if (imported !== null) return imported
    const declaration = symbol?.getDeclarations()?.[0]
    if (declaration && ts.isFunctionDeclaration(declaration)) return `local-function:${identifier.text}`
    if (declaration && ts.isVariableDeclaration(declaration)) return `local-variable:${identifier.text}`
    if (declaration && ts.isParameter(declaration)) return `parameter:${identifier.text}`
    return `identifier:${identifier.text}`
}

function callExpressionIdentity(call, checker, sourceFile) {
    const expression = call.expression
    if (ts.isIdentifier(expression)) return identifierCallIdentity(expression, checker)
    if (ts.isPropertyAccessExpression(expression)) {
        if (ts.isIdentifier(expression.expression)) {
            const moduleSpecifier = namespaceImportModule(
                checker.getSymbolAtLocation(expression.expression),
            )
            if (moduleSpecifier !== null) {
                return `import-namespace:${moduleSpecifier}#${expression.name.text}`
            }
        }
        return `member:${compactExpression(expression.expression, sourceFile)}#${expression.name.text}`
    }
    if (ts.isCallExpression(expression)) {
        return `call-result:${callExpressionIdentity(expression, checker, sourceFile)}`
    }
    return `expression:${ts.SyntaxKind[expression.kind]}:${compactExpression(expression, sourceFile)}`
}

function inventoryCallPhase(call, sourceFile, dominanceEvidence) {
    if (dominanceEvidence === undefined || dominanceEvidence === null) return null
    const { anchorMatch, publicationCall } = dominanceEvidence
    if (call === anchorMatch) return "final-anchor"
    if (call === publicationCall) return "publication"
    if (findAncestor(call.parent, node => node === anchorMatch) !== null) {
        return isExactFinalAnchorCallbackWrite(
            call,
            dominanceEvidence.ownerRoot,
            anchorMatch,
        ) ? "inside-final-anchor" : "final-anchor-evaluation"
    }
    if (findAncestor(call.parent, node => node === publicationCall) !== null) {
        return "inside-publication"
    }
    if (call.end <= anchorMatch.getStart(sourceFile)) return "before-anchor"
    if (call.getStart(sourceFile) >= publicationCall.end) return "after-publication"
    return "anchor-to-publication"
}

function collectOwnerCallInventory(ownerRoot, checker, sourceFile, dominanceEvidence = null) {
    const counts = new Map()
    function visit(node) {
        if (ts.isCallExpression(node)) {
            const identity = callExpressionIdentity(node, checker, sourceFile)
            const phase = inventoryCallPhase(node, sourceFile, dominanceEvidence)
            const key = phase === null ? identity : `${phase}:${identity}`
            counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        ts.forEachChild(node, visit)
    }
    visit(ownerRoot)
    return [...counts].sort(([left], [right]) => left.localeCompare(right))
        .map(([identity, count]) => `${identity}=${count}`)
}

function assertOwnerCallInventory(source, fileName, ownerFunctionName, expected) {
    const { checker, sourceFile } = createTypeCheckedSource(source, fileName)
    const ownerRoot = findExportedFunctionDeclaration(sourceFile, checker, ownerFunctionName)
    assert.deepEqual(
        collectOwnerCallInventory(ownerRoot, checker, sourceFile),
        expected,
        `${fileName} owner call inventory drifted`,
    )
}

function assertAuthoritativeWriteSetInventorySubset(
    ownerRoot,
    checker,
    sourceFile,
    authoritativeWriteNames,
    dominanceEvidence = null,
) {
    const actualInventory = collectOwnerCallInventory(
        ownerRoot,
        checker,
        sourceFile,
        dominanceEvidence,
    )
    const identitiesByTerminal = new Map()
    function visit(node) {
        if (ts.isCallExpression(node)) {
            const terminalName = callTerminalName(node)
            if (terminalName !== null) {
                const identities = identitiesByTerminal.get(terminalName) ?? new Set()
                identities.add(callExpressionIdentity(node, checker, sourceFile))
                identitiesByTerminal.set(terminalName, identities)
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(ownerRoot)
    for (const writeName of authoritativeWriteNames) {
        const identities = identitiesByTerminal.get(writeName)
        assert.equal(
            identities !== undefined && identities.size > 0,
            true,
            `${sourceFile.fileName} write set is not an inventory symbol subset: ${writeName}`,
        )
        for (const identity of identities ?? []) {
            const identityMarker = dominanceEvidence === null ? identity : `:${identity}`
            const inventoryEntries = actualInventory.filter(entry => (
                entry.startsWith(`${identityMarker}=`)
                    || entry.includes(`${identityMarker}=`)
            ))
            assert.equal(
                inventoryEntries.length > 0,
                true,
                `${sourceFile.fileName} write set inventory symbol drifted: ${writeName}:${identity}`,
            )
        }
    }
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
    const growthPublication = source.includes("publishCharacterGrowthOwnerStateBestEffort")
    const awakeImportSymbol = findNamedImportSymbol(
        sourceFile,
        checker,
        growthPublication
            ? "publishCharacterGrowthOwnerStateBestEffort"
            : source.includes("reconcileAwakeUnlockCharacterListBestEffort")
                ? "reconcileAwakeUnlockCharacterListBestEffort"
                : "reconcileAwakeUnlockCharacterList",
        growthPublication
            ? specifier => specifier.endsWith("/character-growth/owner-publication")
            : isMissionModuleSpecifier,
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
    if (callee === "strict" || callee === "growth-facts-in-tx") {
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

function findContextCreation(call, sourceFile, checker, ownerRoot, directContextArgument = false) {
    const options = call.arguments[2]
    const contextReference = directContextArgument
        ? options
        : getObjectProperty(options, "context")
    assert.equal(
        contextReference !== null && ts.isIdentifier(contextReference),
        true,
        `${sourceFile.fileName} scoped reconcile must reference a context variable`,
    )
    assert.notEqual(checker, undefined, `${sourceFile.fileName} context binding requires TypeChecker evidence`)
    const contextSymbol = ts.isShorthandPropertyAssignment(contextReference.parent)
        ? checker.getShorthandAssignmentValueSymbol(contextReference.parent)
        : checker.getSymbolAtLocation(contextReference)
    assert.notEqual(
        contextSymbol,
        undefined,
        `${sourceFile.fileName} publication context symbol is not statically bound`,
    )
    const declarations = (contextSymbol?.getDeclarations() ?? []).filter(ts.isVariableDeclaration)
    assert.equal(
        declarations.length,
        1,
        `${sourceFile.fileName} publication context must have exactly one binding declaration`,
    )
    const declaration = declarations[0]
    assert.notEqual(
        findAncestor(declaration, node => node === ownerRoot),
        null,
        `${sourceFile.fileName} context binding declaration is outside the exact owner root`,
    )
    let declarationScope = null
    for (let node = declaration.parent; node && node !== ownerRoot.parent; node = node.parent) {
        if (ts.isBlock(node) || ts.isSourceFile(node)) {
            declarationScope = node
            break
        }
    }
    assert.notEqual(
        declarationScope,
        null,
        `${sourceFile.fileName} context binding declaration lacks a visible owner scope`,
    )
    assert.notEqual(
        findAncestor(call, node => node === declarationScope),
        null,
        `${sourceFile.fileName} context binding declaration is outside the visible owner scope`,
    )
    assert.equal(
        declaration.getStart(sourceFile) < call.getStart(sourceFile)
            && declaration.initializer !== undefined
            && ts.isCallExpression(declaration.initializer)
            && callTerminalName(declaration.initializer)?.startsWith("createAwakeRequestContext"),
        true,
        `${sourceFile.fileName} context binding declaration is not a visible context creation`,
    )
    return declaration.initializer
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

function extractScopeEvidence(importedCall, ownerRoot = findOwnerRoot(importedCall.call)) {
    const { call, checker, exportedName, sourceFile } = importedCall
    let actualCharacterSeed
    let scope
    let contextStart
    if (exportedName === SINGLE_AWAKE_WRAPPER || exportedName === GROWTH_AWAKE_WRAPPER) {
        actualCharacterSeed = compactExpression(call.arguments[1], sourceFile)
        scope = call.arguments[3]
        contextStart = call.getStart(sourceFile)
    } else {
        const creation = findContextCreation(
            call,
            sourceFile,
            checker,
            ownerRoot,
            GROWTH_AWAKE_FACT_WRITERS.has(exportedName),
        )
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

function assertProductionTutorialConstantLiteral(contract) {
    const relativeFile = "src/lib/start-tutorial-state.ts"
    const source = fs.readFileSync(path.join(projectRoot, relativeFile), "utf8")
    const sourceFile = ts.createSourceFile(
        relativeFile,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    )
    const declarations = []
    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)
            || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
            || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue
        for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)
                && declaration.name.text === contract.constantName) declarations.push(declaration)
        }
    }
    assert.equal(
        declarations.length,
        1,
        `${relativeFile} must export const ${contract.constantName} exactly once`,
    )
    assert.equal(
        declarations[0].initializer !== undefined
            && ts.isNumericLiteral(declarations[0].initializer)
            && Number(declarations[0].initializer.text) === contract.literal,
        true,
        `${relativeFile} ${contract.constantName} must have direct literal ${contract.literal}`,
    )
}

function findTutorialConstantSymbol(sourceFile, checker, contract) {
    assert.notEqual(checker, null, `${contract.constantName} requires TypeChecker evidence`)
    const imported = []
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || !statement.moduleSpecifier.text.endsWith("/start-tutorial-state")) continue
        const bindings = statement.importClause?.namedBindings
        if (!bindings || !ts.isNamedImports(bindings)) continue
        for (const element of bindings.elements) {
            const exportedName = element.propertyName?.text ?? element.name.text
            if (exportedName !== contract.constantName) continue
            assert.equal(
                element.propertyName,
                undefined,
                `${contract.constantName} tutorial constant aliases are not allowed`,
            )
            imported.push(checker.getSymbolAtLocation(element.name))
        }
    }
    if (imported.length > 0) {
        assert.equal(imported.length, 1, `${contract.constantName} must be imported exactly once`)
        assert.notEqual(imported[0], undefined, `${contract.constantName} import symbol is missing`)
        assertProductionTutorialConstantLiteral(contract)
        return imported[0]
    }

    const declarations = []
    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)
            || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue
        for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)
                && declaration.name.text === contract.constantName) declarations.push(declaration)
        }
    }
    assert.equal(declarations.length, 1, `${contract.constantName} constant symbol is not exact`)
    assert.equal(
        declarations[0].initializer !== undefined
            && ts.isNumericLiteral(declarations[0].initializer)
            && Number(declarations[0].initializer.text) === contract.literal,
        true,
        `${contract.constantName} must have direct literal ${contract.literal}; aliases are not allowed`,
    )
    const symbol = checker.getSymbolAtLocation(declarations[0].name)
    assert.notEqual(symbol, undefined, `${contract.constantName} constant symbol is missing`)
    return symbol
}

function isExactEffectiveNextStepReference(reference, call, checker) {
    if (!ts.isIdentifier(reference)) return false
    const symbol = checker.getSymbolAtLocation(reference)
    const declarations = (symbol?.getDeclarations() ?? []).filter(ts.isVariableDeclaration)
    if (declarations.length !== 1) return false
    const declaration = declarations[0]
    if (!ts.isIdentifier(declaration.name)
        || declaration.name.text !== "effectiveNextStep"
        || declaration.getStart(call.getSourceFile()) >= call.getStart(call.getSourceFile())
        || declaration.initializer === undefined
        || !ts.isCallExpression(declaration.initializer)
        || callTerminalName(declaration.initializer) !== "getTutorialEffectiveNextStep") {
        return false
    }
    let declarationScope = null
    for (let node = declaration.parent; node; node = node.parent) {
        if (ts.isBlock(node) || ts.isSourceFile(node)) {
            declarationScope = node
            break
        }
    }
    return declarationScope !== null
        && findAncestor(call, node => node === declarationScope) !== null
}

function findTutorialOwnerBranch(call, ownerLabel, checker, required = true) {
    const contract = TUTORIAL_OWNER_SCOPE_CONTRACTS[ownerLabel]
    assert.notEqual(contract, undefined, `${ownerLabel} lacks a tutorial scope contract`)
    const symbol = findTutorialConstantSymbol(call.getSourceFile(), checker, contract)
    const matches = []
    for (let parent = call.parent; parent; parent = parent.parent) {
        if (!ts.isIfStatement(parent) || !ts.isBinaryExpression(parent.expression)) continue
        if (parent.expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) continue
        const operands = [parent.expression.left, parent.expression.right]
        const constantIndex = operands.findIndex(operand => (
            ts.isIdentifier(operand) && checker.getSymbolAtLocation(operand) === symbol
        ))
        if (constantIndex === -1) continue
        assert.equal(
            isExactEffectiveNextStepReference(operands[1 - constantIndex], call, checker),
            true,
            `${ownerLabel} branch discriminator must reference the exact effectiveNextStep symbol`,
        )
        assert.equal(
            call.getStart() >= parent.thenStatement.getStart()
                && call.end <= parent.thenStatement.end,
            true,
            `${ownerLabel} publication must remain in its exact tutorial branch`,
        )
        matches.push(parent.thenStatement)
    }
    if (!required && matches.length === 0) return null
    assert.equal(matches.length, 1, `${ownerLabel} publication owner branch is not traceable exactly once`)
    return matches[0]
}

function findOwnerRoot(call, ownerLabel = null, checker = null) {
    if (TUTORIAL_OWNER_SCOPE_CONTRACTS[ownerLabel] !== undefined) {
        return findTutorialOwnerBranch(call, ownerLabel, checker)
    }
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

function isShortCircuitExpression(node) {
    return ts.isBinaryExpression(node) && [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
    ].includes(node.operatorToken.kind)
}

function isConditionalExecutionNode(node) {
    return ts.isIfStatement(node)
        || ts.isSwitchStatement(node)
        || ts.isTryStatement(node)
        || ts.isCatchClause(node)
        || ts.isCaseClause(node)
        || ts.isDefaultClause(node)
        || ts.isForStatement(node)
        || ts.isForInStatement(node)
        || ts.isForOfStatement(node)
        || ts.isWhileStatement(node)
        || ts.isDoStatement(node)
        || ts.isConditionalExpression(node)
        || isShortCircuitExpression(node)
}

function isImmediatelyInvokedFunction(node) {
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false
    let expression = node
    let parent = node.parent
    while (ts.isParenthesizedExpression(parent) && parent.expression === expression) {
        expression = parent
        parent = parent.parent
    }
    return ts.isCallExpression(parent) && parent.expression === expression
}

function hasOptionalCalleeChain(call) {
    for (let node = call; node;) {
        if (node.questionDotToken) return true
        if (ts.isCallExpression(node)
            || ts.isPropertyAccessExpression(node)
            || ts.isElementAccessExpression(node)) {
            node = node.expression
            continue
        }
        return false
    }
    return false
}

function isExactFinalAnchorCallbackWrite(call, ownerRoot, anchorMatch) {
    if (callTerminalName(anchorMatch) !== "transaction") return false
    const callback = anchorMatch.arguments[0]
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
        return false
    }
    const nestedFunctions = nonImmediateFunctionAncestors(call, ownerRoot)
    return nestedFunctions.length === 1 && nestedFunctions[0] === callback
}

function isExactOwnerTransactionCallbackWrite(call, ownerRoot, publicationCall) {
    const nestedFunctions = nonImmediateFunctionAncestors(call, ownerRoot)
    if (nestedFunctions.length !== 1) return false
    const callback = nestedFunctions[0]
    const transactionCall = callback.parent
    if (!ts.isCallExpression(transactionCall)
        || callTerminalName(transactionCall) !== "transaction"
        || transactionCall.arguments[0] !== callback
        || hasOptionalCalleeChain(transactionCall)) return false
    return publicationCall.getStart() >= callback.getStart()
        && publicationCall.end <= callback.end
}

function isReviewedSyncCallbackWrite(call, ownerRoot, ownerLabel) {
    const callbackContract = ownerLabel === "single/finish"
        ? SINGLE_SYNC_AUTHORITATIVE_CALLBACKS
        : ownerLabel === "tutorial/update_step:15"
            ? TUTORIAL_STEP_15_SYNC_AUTHORITATIVE_CALLBACKS
            : null
    if (callbackContract === null) return false
    const nestedFunctions = nonImmediateFunctionAncestors(call, ownerRoot)
    if (nestedFunctions.length !== 1) return false
    const callback = nestedFunctions[0]
    if (!ts.isPropertyAssignment(callback.parent)) return false
    const callbackName = propertyName(callback.parent)
    const writeName = callTerminalName(call)
    return callbackName !== null
        && writeName !== null
        && callbackContract[callbackName]?.includes(writeName) === true
}

function isDirectUnconditionalCallInStatement(call, statement) {
    if (hasOptionalCalleeChain(call)) return false
    for (let node = call.parent; node && node !== statement; node = node.parent) {
        if (isConditionalExecutionNode(node)) return false
        if (ts.isFunctionLike(node) && !isImmediatelyInvokedFunction(node)) return false
    }
    return call.getStart() >= statement.getStart()
        && call.end <= statement.end
        && !isConditionalExecutionNode(statement)
}

function catchAlwaysExits(tryStatement) {
    if (tryStatement.finallyBlock || !tryStatement.catchClause) return false
    const statements = tryStatement.catchClause.block.statements
    return statements.length > 0 && ts.isThrowStatement(statements.at(-1))
}

function collectExecutableCallsInRange(statement, start, end, authoritativeWrites) {
    const calls = []
    function visit(node) {
        if (ts.isCallExpression(node)
            && node.getStart() > start
            && node.getStart() < end
            && authoritativeWrites.has(callTerminalName(node))) calls.push(node)
        ts.forEachChild(node, visit)
    }
    visit(statement)
    return calls
}

function assertFinalWritePrecedesContext(
    call,
    contextStart,
    anchor,
    ownerLabel = null,
    authoritativeWriteNames = [anchor],
    finalWriteRule = "same-block-direct",
    checker = null,
) {
    const sourceFile = call.getSourceFile()
    const ownerRoot = findOwnerRoot(call, ownerLabel, checker)
    const authoritativeWrites = new Set(authoritativeWriteNames)
    assert.equal(authoritativeWrites.has(anchor), true, `${anchor} must belong to the authoritative write set`)
    const anchorMatches = []
    const observedAuthoritativeWrites = new Set()
    const observedAuthoritativeCalls = []
    function visit(node) {
        if (ts.isCallExpression(node)) {
            const terminalName = callTerminalName(node)
            if (terminalName === anchor) anchorMatches.push(node)
            if (authoritativeWrites.has(terminalName)) {
                observedAuthoritativeWrites.add(terminalName)
                observedAuthoritativeCalls.push(node)
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(ownerRoot)
    assert.deepEqual(
        [...observedAuthoritativeWrites].sort(),
        [...authoritativeWrites].sort(),
        `${sourceFile.fileName} authoritative write set does not resolve to owner calls`,
    )
    const publicationBlocks = []
    for (let node = call.parent; node; node = node.parent) {
        if (ts.isBlock(node)) publicationBlocks.push(node)
        if (node === ownerRoot) break
    }
    let dominanceEvidence = null
    for (const block of publicationBlocks) {
        const publicationStatement = block.statements.find(statement => (
            call.getStart(sourceFile) >= statement.getStart(sourceFile)
                && call.end <= statement.end
        ))
        if (publicationStatement === undefined) continue
        const publicationIndex = block.statements.indexOf(publicationStatement)
        let directAnchor = null
        for (const [index, statement] of block.statements.entries()) {
            if (index >= publicationIndex) break
            const match = anchorMatches.find(candidate => (
                candidate.end <= contextStart
                    && isDirectUnconditionalCallInStatement(candidate, statement)
            ))
            if (match !== undefined) {
                directAnchor = { match, statementIndex: index }
                break
            }
        }
        if (directAnchor !== null) {
            dominanceEvidence = {
                anchorMatch: directAnchor.match,
                anchorStatementIndex: directAnchor.statementIndex,
                block,
                publicationIndex,
                publicationStatement,
            }
            break
        }
        if (finalWriteRule !== "owner-transaction-statement" || ownerLabel === null) continue
        assert.equal(
            OWNER_TRANSACTION_ANCHORS[ownerLabel],
            anchor,
            `${ownerLabel} lacks an exact outer transaction anchor rule for ${anchor}`,
        )
        let transactionAnchor = null
        for (const [index, statement] of block.statements.entries()) {
            if (index >= publicationIndex) break
            if (!ts.isTryStatement(statement)
                || !catchAlwaysExits(statement)
                || statement.tryBlock.statements.length === 0) continue
            const match = anchorMatches.find(candidate => (
                candidate.end <= contextStart
                    && isDirectUnconditionalCallInStatement(
                        candidate,
                        statement.tryBlock.statements.at(-1),
                    )
            ))
            if (match !== undefined) {
                transactionAnchor = { match, statementIndex: index }
                break
            }
        }
        if (transactionAnchor !== null) {
            dominanceEvidence = {
                anchorMatch: transactionAnchor.match,
                anchorStatementIndex: transactionAnchor.statementIndex,
                block,
                publicationIndex,
                publicationStatement,
            }
            break
        }
    }
    assert.equal(
        dominanceEvidence !== null,
        true,
        `${sourceFile.fileName} final authoritative write ${anchor} does not dominate publication on the same control-flow path`,
    )
    for (const writeCall of observedAuthoritativeCalls) {
        if (writeCall === dominanceEvidence.anchorMatch) continue
        const nestedFunctions = nonImmediateFunctionAncestors(writeCall, ownerRoot)
        const inFinalCallback = isExactFinalAnchorCallbackWrite(
            writeCall,
            ownerRoot,
            dominanceEvidence.anchorMatch,
        )
        const inReviewedSyncCallback = isReviewedSyncCallbackWrite(
            writeCall,
            ownerRoot,
            ownerLabel,
        )
        const inOwnerTransactionCallback = isExactOwnerTransactionCallbackWrite(
            writeCall,
            ownerRoot,
            call,
        )
        assert.equal(
            nestedFunctions.length === 0
                || inFinalCallback
                || inOwnerTransactionCallback
                || inReviewedSyncCallback,
            true,
            `${sourceFile.fileName} authoritative write ${callTerminalName(writeCall)} is deferred in an unreviewed non-immediate callback`,
        )
        const insideAnchor = findAncestor(
            writeCall.parent,
            node => node === dominanceEvidence.anchorMatch,
        ) !== null
        assert.equal(
            !insideAnchor || inFinalCallback,
            true,
            `${sourceFile.fileName} authoritative write ${callTerminalName(writeCall)} is evaluated outside the final anchor callback argument`,
        )
    }
    const between = collectExecutableCallsInRange(
        ownerRoot,
        dominanceEvidence.anchorMatch.end,
        call.getStart(sourceFile),
        authoritativeWrites,
    )
    assert.equal(
        between.length,
        0,
        `${sourceFile.fileName} has authoritative write ${between
            .map(match => callTerminalName(match)).join(", ")} between final anchor and publication`,
    )
    const later = collectExecutableCallsInRange(
        ownerRoot,
        call.end,
        Number.POSITIVE_INFINITY,
        authoritativeWrites,
    )
    assert.equal(
        later.length,
        0,
        `${sourceFile.fileName} has a later authoritative write ${later
            .map(match => callTerminalName(match)).join(", ")} after publication`,
    )
    return {
        ...dominanceEvidence,
        ownerRoot,
        ownerLabel,
        publicationCall: call,
    }
}

function collectProductionCalls() {
    const files = ts.sys.readDirectory(sourceRoot, [".ts"], undefined, undefined)
    const calls = []
    for (const file of files) {
        const relativeFile = path.relative(projectRoot, file).split(path.sep).join("/")
        if (relativeFile === "src/lib/mission/awake-unlock-response.ts"
            || relativeFile === "src/lib/mission/awake-best-effort-context.ts"
            || relativeFile === "src/lib/character-growth/owner-publication.ts"
            || relativeFile === "src/lib/character-growth/facts/awake-unlock-facts.ts") continue
        const source = fs.readFileSync(file, "utf8")
        for (const importedCall of collectImportedAwakeCalls(source, relativeFile)) {
            const { call, callee, checker, exportedName, moduleSpecifier, sourceFile } = importedCall
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
            } else if (exportedName === GROWTH_AWAKE_WRAPPER) {
                assert.ok(
                    call.arguments.length === 4 || call.arguments.length === 5 || call.arguments.length === 6,
                    `${relativeFile} Growth owner publication must use the supported signature`,
                )
            } else if (GROWTH_AWAKE_FACT_WRITERS.has(exportedName)) {
                assert.equal(
                    call.arguments.length,
                    4,
                    `${relativeFile} Growth fact writer must use the supported signature`,
                )
            } else {
                assert.ok(
                    call.arguments.length === 2 || call.arguments.length === 3,
                    `${relativeFile} publication must use the supported signature`,
                )
            }
            if (call.arguments.length === 3 && exportedName !== SINGLE_AWAKE_WRAPPER
                && exportedName !== GROWTH_AWAKE_WRAPPER
                && !GROWTH_AWAKE_FACT_WRITERS.has(exportedName)) {
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
            const ownerLabel = classifyOwner(relativeFile, call, sourceFile, checker)
            const expected = EXPECTED_MATRIX.filter(entry => entry.owner === ownerLabel)
            assert.equal(expected.length, 1, `${ownerLabel} must have exactly one matrix row`)
            const ownerRoot = findOwnerRoot(call, ownerLabel, checker)
            const finalHelper = FINAL_WRITE_HELPERS[ownerLabel]
            if (finalHelper !== undefined) {
                assert.equal(
                    finalHelper.helperName,
                    expected[0].finalAuthoritativeWrite,
                    `${ownerLabel} final helper drifted from its matrix anchor`,
                )
                assertFinalWriteHelperOwnershipInSource(
                    sourceFile,
                    checker,
                    ownerRoot,
                    finalHelper,
                )
            }
            const scopeEvidence = extractScopeEvidence(importedCall, ownerRoot)
            const dominanceEvidence = assertFinalWritePrecedesContext(
                call,
                scopeEvidence.contextStart,
                expected[0].finalAuthoritativeWrite,
                ownerLabel,
                expected[0].authoritativeWriteSet,
                expected[0].finalWriteRule,
                checker,
            )
            assertAuthoritativeWriteSetInventorySubset(
                ownerRoot,
                checker,
                sourceFile,
                expected[0].authoritativeWriteSet,
                dominanceEvidence,
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
                        : exportedName === GROWTH_AWAKE_WRAPPER
                            ? call.arguments.length >= 4
                            : GROWTH_AWAKE_FACT_WRITERS.has(exportedName)
                                ? call.arguments.length === 4
                            : call.arguments.length === 3
                ) ? "scoped-context" : "legacy-unscoped",
                plannedCandidateSource: PLANNED_CANDIDATE_SOURCES[ownerLabel],
                owner: ownerLabel,
                actualCharacterSeed: scopeEvidence.actualCharacterSeed,
                actualFactSeeds: scopeEvidence.actualFactSeeds,
                directMissionSeed: scopeEvidence.directMissionSeed,
                finalAuthoritativeWrite: expected[0].finalAuthoritativeWrite,
                authoritativeWriteSet: expected[0].authoritativeWriteSet,
                finalWriteRule: expected[0].finalWriteRule,
                snapshotSource: scopeEvidence.snapshotSource,
                rereadReason: expected[0].rereadReason,
                sqlUpperBoundKey: expected[0].sqlUpperBoundKey,
                runtimeEvidenceKey: expected[0].runtimeEvidenceKey,
                ownerCallInventory: collectOwnerCallInventory(
                    ownerRoot,
                    checker,
                    sourceFile,
                    dominanceEvidence,
                ),
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
        assert.equal(Array.isArray(entry.authoritativeWriteSet), true, `${entry.owner} lacks a write set`)
        assert.equal(entry.authoritativeWriteSet.length > 0, true, `${entry.owner} has an empty write set`)
        assert.equal(
            new Set(entry.authoritativeWriteSet).size,
            entry.authoritativeWriteSet.length,
            `${entry.owner} has duplicate authoritative writes`,
        )
        assert.equal(
            entry.authoritativeWriteSet.includes(entry.finalAuthoritativeWrite),
            true,
            `${entry.owner} final anchor is absent from its authoritative write set`,
        )
        if (entry.finalWriteRule === "owner-transaction-statement") {
            assert.equal(
                OWNER_TRANSACTION_ANCHORS[entry.owner],
                entry.finalAuthoritativeWrite,
                `${entry.owner} lacks its exact outer transaction anchor rule`,
            )
        } else {
            assert.equal(entry.finalWriteRule, "same-block-direct")
            assert.equal(OWNER_TRANSACTION_ANCHORS[entry.owner], undefined)
        }
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
        "directMissionSeed", "finalAuthoritativeWrite", "authoritativeWriteSet",
        "finalWriteRule", "snapshotSource",
        "rereadReason", "sqlUpperBoundKey", "runtimeEvidenceKey",
    ]
    assert.deepEqual(
        calls.map(call => Object.fromEntries(comparedFields.map(field => [field, call[field]]))),
        EXPECTED_MATRIX.map(entry => Object.fromEntries(comparedFields.map(field => [field, entry[field]]))),
    )
    assert.equal(new Set(calls.map(call => `${call.relativeFile}:${call.position}`)).size, 21)
    assertEvidenceContract(EXPECTED_MATRIX)
})

test("production owner call inventories freeze every reviewed symbol, count, and phase", () => {
    const actual = Object.fromEntries(collectProductionCalls().map(call => [
        call.owner,
        call.ownerCallInventory,
    ]))
    if (process.argv.includes("--write-owner-inventory")) {
        fs.writeFileSync(
            path.join(__dirname, "awake_reconcile_owner_call_inventory.json"),
            `${JSON.stringify(actual, null, 2)}\n`,
        )
        return
    }
    assert.deepEqual(actual, OWNER_CALL_INVENTORIES, "production owner call inventory drifted")
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
    const single = EXPECTED_MATRIX.find(entry => entry.owner === "single/finish")
    assert.equal(single.plannedCandidateSource, "battle-party+invalidated-facts")
    assert.equal(single.directMissionSeed, "awakePublication.directMissionIds")
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
        matrix => { matrix.find(entry => entry.owner === "single/finish").actualFactSeeds = "none" },
        matrix => { matrix[0].runtimeEvidenceKey = "missing-runtime-evidence" },
        matrix => { matrix[0].sqlUpperBoundKey = "missing-sql-bound" },
        matrix => { matrix[0].authoritativeWriteSet = [] },
        matrix => { matrix[0].authoritativeWriteSet = ["deletePlayerActiveQuestSync"] },
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

test("context creation binds to the publication context symbol in its visible owner scope", () => {
    const source = `
        import {
            createAwakeRequestContextBestEffort,
            reconcileAwakeUnlockCharacterListBestEffort,
        } from "./mission"
        function unrelated() {
            const awakeContext = createAwakeRequestContextBestEffort(99, [999], {})
            return awakeContext
        }
        export function owner() {
            const awakeContext = loadUnrelatedContext()
            return reconcileAwakeUnlockCharacterListBestEffort(
                1,
                [],
                { context: awakeContext },
            )
        }
    `
    const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]

    assert.throws(
        () => extractScopeEvidence(importedCall),
        /context.*symbol|binding declaration|visible owner scope/i,
    )
})

test("context creation rejects a file-scoped binding outside the Fastify owner root", () => {
    const source = `
        import {
            createAwakeRequestContextBestEffort,
            reconcileAwakeUnlockCharacterListBestEffort,
        } from "./mission"
        const awakeContext = createAwakeRequestContextBestEffort(1, [], {})
        export function routes(fastify) {
            fastify.post("/owner", () => {
                return reconcileAwakeUnlockCharacterListBestEffort(
                    1,
                    [],
                    { context: awakeContext },
                )
            })
        }
    `
    const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]

    assert.throws(
        () => extractScopeEvidence(importedCall),
        /context binding declaration.*owner root|visible owner scope/i,
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

test("final-write evidence rejects a write inside a preceding conditional statement", () => {
    const source = `
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner(condition) {
            if (condition) persistPlayer()
            publishAwakeCharacterListBestEffort(1, [], [], {})
        }
    `
    const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]
    const scope = extractScopeEvidence(importedCall)

    assert.throws(
        () => assertFinalWritePrecedesContext(importedCall.call, scope.contextStart, "persistPlayer"),
        /same control-flow path|dominat/i,
    )
})

test("final-write evidence rejects an optional property anchor", () => {
    const source = `
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner(writer) {
            writer?.persistPlayer()
            publishAwakeCharacterListBestEffort(1, [], [], {})
        }
    `
    const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]
    const scope = extractScopeEvidence(importedCall)

    assert.throws(
        () => assertFinalWritePrecedesContext(importedCall.call, scope.contextStart, "persistPlayer"),
        /same control-flow path|optional|dominat/i,
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

test("final-write evidence rejects a differently named authoritative write after publication", () => {
    const source = `
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner() {
            persistPlayer()
            publishAwakeCharacterListBestEffort(1, [], [], {})
            updatePlayerSync()
        }
    `
    const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]
    const scope = extractScopeEvidence(importedCall)

    assert.throws(
        () => assertFinalWritePrecedesContext(
            importedCall.call,
            scope.contextStart,
            "persistPlayer",
            null,
            ["persistPlayer", "updatePlayerSync"],
        ),
        /after.*publication|later authoritative write.*updatePlayerSync/i,
    )
})

test("final-write evidence rejects the same authoritative write between anchor and publication", () => {
    const source = `
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner() {
            persistPlayer()
            persistPlayer()
            publishAwakeCharacterListBestEffort(1, [], [], {})
        }
    `
    const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]
    const scope = extractScopeEvidence(importedCall)

    assert.throws(
        () => assertFinalWritePrecedesContext(importedCall.call, scope.contextStart, "persistPlayer"),
        /between.*anchor.*publication|after.*final.*anchor/i,
    )
})

test("final-write evidence rejects a differently named write between anchor and publication", () => {
    const source = `
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner() {
            persistPlayer()
            updatePlayerSync()
            publishAwakeCharacterListBestEffort(1, [], [], {})
        }
    `
    const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]
    const scope = extractScopeEvidence(importedCall)

    assert.throws(
        () => assertFinalWritePrecedesContext(
            importedCall.call,
            scope.contextStart,
            "persistPlayer",
            null,
            ["persistPlayer", "updatePlayerSync"],
        ),
        /between.*anchor.*publication|after.*final.*anchor.*updatePlayerSync/i,
    )
})

test("final-write evidence rejects an authoritative write hidden in a deferred callback before publication", () => {
    const source = `
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner() {
            persistPlayer()
            queue(() => updatePlayerSync())
            publishAwakeCharacterListBestEffort(1, [], [], {})
        }
    `
    const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]
    const scope = extractScopeEvidence(importedCall)

    assert.throws(
        () => assertFinalWritePrecedesContext(
            importedCall.call,
            scope.contextStart,
            "persistPlayer",
            null,
            ["persistPlayer", "updatePlayerSync"],
        ),
        /between.*anchor.*publication|updatePlayerSync/i,
    )
})

test("final-write evidence rejects an authoritative write hidden in a deferred callback after publication", () => {
    const source = `
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner() {
            persistPlayer()
            publishAwakeCharacterListBestEffort(1, [], [], {})
            queue(() => updatePlayerSync())
        }
    `
    const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]
    const scope = extractScopeEvidence(importedCall)

    assert.throws(
        () => assertFinalWritePrecedesContext(
            importedCall.call,
            scope.contextStart,
            "persistPlayer",
            null,
            ["persistPlayer", "updatePlayerSync"],
        ),
        /after.*publication|updatePlayerSync/i,
    )
})

test("final-write evidence rejects a deferred write declared before the anchor and invoked after publication", () => {
    const source = `
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner() {
            const deferred = () => updatePlayerSync()
            persistPlayer()
            publishAwakeCharacterListBestEffort(1, [], [], {})
            deferred()
        }
    `
    const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]
    const scope = extractScopeEvidence(importedCall)

    assert.throws(
        () => assertFinalWritePrecedesContext(
            importedCall.call,
            scope.contextStart,
            "persistPlayer",
            null,
            ["persistPlayer", "updatePlayerSync"],
        ),
        /deferred|non-immediate|updatePlayerSync/i,
    )
})

test("final-write evidence rejects writes evaluated in ordinary final-anchor arguments", () => {
    const source = `
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner() {
            transaction(updatePlayerSync(), () => {})
            publishAwakeCharacterListBestEffort(1, [], [], {})
        }
    `
    const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]
    const scope = extractScopeEvidence(importedCall)

    assert.throws(
        () => assertFinalWritePrecedesContext(
            importedCall.call,
            scope.contextStart,
            "transaction",
            null,
            ["transaction", "updatePlayerSync"],
        ),
        /callback argument|outside.*final anchor|updatePlayerSync/i,
    )
})

test("final-write evidence rejects an outer-block authoritative write after an inner publication", () => {
    const source = `
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner() {
            {
                persistPlayer()
                publishAwakeCharacterListBestEffort(1, [], [], {})
            }
            updatePlayerSync()
        }
    `
    const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]
    const scope = extractScopeEvidence(importedCall)

    assert.throws(
        () => assertFinalWritePrecedesContext(
            importedCall.call,
            scope.contextStart,
            "persistPlayer",
            null,
            ["persistPlayer", "updatePlayerSync"],
        ),
        /after.*publication|updatePlayerSync/i,
    )
})

test("outer transaction anchors require an exact owner-specific rule", () => {
    const source = `
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner() {
            try {
                transaction()
            } catch (error) {
                throw error
            }
            publishAwakeCharacterListBestEffort(1, [], [], {})
        }
    `
    const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]
    const scope = extractScopeEvidence(importedCall)

    assert.throws(
        () => assertFinalWritePrecedesContext(importedCall.call, scope.contextStart, "transaction"),
        /same control-flow path|dominat/i,
    )
    assert.doesNotThrow(() => assertFinalWritePrecedesContext(
        importedCall.call,
        scope.contextStart,
        "transaction",
        "box_gacha/exec",
        ["transaction"],
        "owner-transaction-statement",
    ))
    assert.throws(
        () => assertFinalWritePrecedesContext(
            importedCall.call,
            scope.contextStart,
            "transaction",
            "shop/buy",
            ["transaction"],
            "owner-transaction-statement",
        ),
        /exact outer transaction anchor rule/i,
    )
})

test("final-write helper ownership binds the owner call and internal production write symbols", () => {
    const source = `
        import { persistPlayer } from "./player-domain"
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        function finalizePublication(condition) {
            if (condition) persistPlayer()
        }
        export function owner(condition) {
            finalizePublication(condition)
            publishAwakeCharacterListBestEffort(1, [], [], {})
        }
    `

    assert.doesNotThrow(() => assertFinalWriteHelperOwnership(source, "synthetic.ts", {
        helperName: "finalizePublication",
        ownerFunctionName: "owner",
        callInventory: ["import:./player-domain#persistPlayer=1"],
        executionInventory: ["sync:import:./player-domain#persistPlayer=1"],
        internalWrites: [{ kind: "import", name: "persistPlayer" }],
    }))
    const extraCall = source.replace(
        'import { persistPlayer }',
        'import { loadPlayer, persistPlayer }',
    ).replace("if (condition) persistPlayer()", "loadPlayer()\nif (condition) persistPlayer()")
    assert.throws(
        () => assertFinalWriteHelperOwnership(extraCall, "synthetic.ts", {
            helperName: "finalizePublication",
            ownerFunctionName: "owner",
            callInventory: ["import:./player-domain#persistPlayer=1"],
            executionInventory: [
                "sync:import:./player-domain#loadPlayer=1",
                "sync:import:./player-domain#persistPlayer=1",
            ],
            internalWrites: [{ kind: "import", name: "persistPlayer" }],
        }),
        /helper.*unreviewed call|complete call inventory/i,
    )
})

test("final-write helper ownership rejects writes hidden in returned callbacks", () => {
    const source = `
        import { persistPlayer } from "./player-domain"
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        function finalizePublication() {
            return () => persistPlayer()
        }
        export function owner() {
            finalizePublication()
            publishAwakeCharacterListBestEffort(1, [], [], {})
        }
    `

    assert.throws(
        () => assertFinalWriteHelperOwnership(source, "synthetic.ts", {
            helperName: "finalizePublication",
            ownerFunctionName: "owner",
            callInventory: ["import:./player-domain#persistPlayer=1"],
            executionInventory: ["deferred:import:./player-domain#persistPlayer=1"],
            internalWrites: [{ kind: "import", name: "persistPlayer" }],
        }),
        /helper.*deferred|nested non-IIFE|synchronous/i,
    )
})

test("parenthesized immediately invoked functions remain synchronous", () => {
    const sourceFile = ts.createSourceFile(
        "synthetic.ts",
        `export function owner() { (() => persistPlayer())() }`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    )
    let callback = null
    function visit(node) {
        if (ts.isArrowFunction(node)) callback = node
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)

    assert.notEqual(callback, null)
    assert.equal(isImmediatelyInvokedFunction(callback), true)
})

test("owner call inventory fails closed on an unreviewed production symbol", () => {
    const expected = [
        "import:./awake-best-effort-context#publishAwakeCharacterListBestEffort=1",
        "import:./player-domain#persistPlayer=1",
    ]
    const source = `
        import { persistPlayer } from "./player-domain"
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner() {
            persistPlayer()
            publishAwakeCharacterListBestEffort(1, [], [], {})
        }
    `
    const changed = source.replace(
        "import { persistPlayer }",
        "import { loadPlayer, persistPlayer }",
    ).replace("persistPlayer()", "loadPlayer()\npersistPlayer()")

    assert.doesNotThrow(() => assertOwnerCallInventory(
        source,
        "synthetic.ts",
        "owner",
        expected,
    ))
    assert.throws(
        () => assertOwnerCallInventory(changed, "synthetic.ts", "owner", expected),
        /call inventory.*drift/i,
    )
})

test("owner call inventory rejects moving the same persistent symbol outside its final transaction", () => {
    function inventoryFor(source) {
        const importedCall = collectImportedAwakeCalls(source, "synthetic.ts")[0]
        const scope = extractScopeEvidence(importedCall)
        const ownerRoot = findOwnerRoot(importedCall.call)
        const dominance = assertFinalWritePrecedesContext(
            importedCall.call,
            scope.contextStart,
            "transaction",
        )
        return collectOwnerCallInventory(
            ownerRoot,
            importedCall.checker,
            importedCall.sourceFile,
            dominance,
        )
    }
    const owned = `
        import { updatePlayerSync } from "./player-domain"
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner() {
            transaction(() => {
                updatePlayerSync()
            })
            publishAwakeCharacterListBestEffort(1, [], [], {})
        }
    `
    const movedAfterPublication = `
        import { updatePlayerSync } from "./player-domain"
        import { publishAwakeCharacterListBestEffort } from "./awake-best-effort-context"
        export function owner() {
            transaction(() => {})
            publishAwakeCharacterListBestEffort(1, [], [], {})
            updatePlayerSync()
        }
    `

    assert.notDeepEqual(
        inventoryFor(owned),
        inventoryFor(movedAfterPublication),
        "inventory roles must expose writes moved across the transaction/publication boundary",
    )
})

test("tutorial owner scopes isolate step 15 and step 16 sibling branches", () => {
    const source = `
        import { reconcileAwakeUnlockCharacterListBestEffort } from "./mission"
        const TUTORIAL_GACHA_EFFECTIVE_STEP = 15
        const TUTORIAL_PRESENT_EFFECTIVE_STEP = 16
        export function routes(fastify) {
            fastify.post("/update_step", () => {
                const effectiveNextStep = getTutorialEffectiveNextStep()
                if (effectiveNextStep === TUTORIAL_GACHA_EFFECTIVE_STEP) {
                    persistStep15()
                    reconcileAwakeUnlockCharacterListBestEffort(1, [], {})
                }
                if (TUTORIAL_PRESENT_EFFECTIVE_STEP === effectiveNextStep) {
                    persistStep16()
                    reconcileAwakeUnlockCharacterListBestEffort(1, [], {})
                }
            })
        }
    `
    const calls = collectImportedAwakeCalls(source, "src/routes/api/tutorial.ts")
    const step15Scope = findOwnerRoot(
        calls[0].call,
        "tutorial/update_step:15",
        calls[0].checker,
    )
    const step16Scope = findOwnerRoot(
        calls[1].call,
        "tutorial/update_step:16",
        calls[1].checker,
    )

    assert.notEqual(step15Scope, step16Scope, "tutorial owners must not share the route callback root")
    assert.match(step15Scope.getText(calls[0].sourceFile), /persistStep15/)
    assert.doesNotMatch(step15Scope.getText(calls[0].sourceFile), /persistStep16/)
    assert.match(step16Scope.getText(calls[1].sourceFile), /persistStep16/)
    assert.doesNotMatch(step16Scope.getText(calls[1].sourceFile), /persistStep15/)
})

test("tutorial owner scopes reject storedNextStep as the branch discriminator", () => {
    const source = `
        import { reconcileAwakeUnlockCharacterListBestEffort } from "./mission"
        const TUTORIAL_GACHA_EFFECTIVE_STEP = 15
        const TUTORIAL_PRESENT_EFFECTIVE_STEP = 16
        export function routes(fastify) {
            fastify.post("/update_step", () => {
                const effectiveNextStep = getTutorialEffectiveNextStep()
                const storedNextStep = getStoredNextStep()
                if (storedNextStep === TUTORIAL_GACHA_EFFECTIVE_STEP) {
                    reconcileAwakeUnlockCharacterListBestEffort(1, [], {})
                }
            })
        }
    `
    const call = collectImportedAwakeCalls(source, "src/routes/api/tutorial.ts")[0]

    assert.throws(
        () => findOwnerRoot(call.call, "tutorial/update_step:15", call.checker),
        /effectiveNextStep.*symbol|branch discriminator/i,
    )
})

test("tutorial owner scopes reject constants aliased to the sibling step", () => {
    const source = `
        import { reconcileAwakeUnlockCharacterListBestEffort } from "./mission"
        const STEP_15 = 15
        const STEP_16 = 16
        const TUTORIAL_GACHA_EFFECTIVE_STEP = STEP_16
        const TUTORIAL_PRESENT_EFFECTIVE_STEP = STEP_15
        export function routes(fastify) {
            fastify.post("/update_step", () => {
                if (effectiveNextStep === TUTORIAL_GACHA_EFFECTIVE_STEP) {
                    reconcileAwakeUnlockCharacterListBestEffort(1, [], {})
                }
                if (effectiveNextStep === TUTORIAL_PRESENT_EFFECTIVE_STEP) {
                    reconcileAwakeUnlockCharacterListBestEffort(1, [], {})
                }
            })
        }
    `
    const calls = collectImportedAwakeCalls(source, "src/routes/api/tutorial.ts")

    assert.throws(
        () => findOwnerRoot(calls[0].call, "tutorial/update_step:15", calls[0].checker),
        /literal 15|constant symbol|alias/i,
    )
    assert.throws(
        () => findOwnerRoot(calls[1].call, "tutorial/update_step:16", calls[1].checker),
        /literal 16|constant symbol|alias/i,
    )
})

test("authoritative write set must be a real symbol subset of the frozen inventory", () => {
    const source = `
        import { persistPlayer } from "./player-domain"
        export function owner() {
            persistPlayer()
        }
    `
    const { checker, sourceFile } = createTypeCheckedSource(source, "synthetic.ts")
    const ownerRoot = findExportedFunctionDeclaration(sourceFile, checker, "owner")

    assert.doesNotThrow(() => assertAuthoritativeWriteSetInventorySubset(
        ownerRoot,
        checker,
        sourceFile,
        ["persistPlayer"],
    ))

    assert.throws(
        () => assertAuthoritativeWriteSetInventorySubset(
            ownerRoot,
            checker,
            sourceFile,
            ["persistPlayer", "missingWrite"],
        ),
        /write set.*inventory.*missingWrite/i,
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
