import { getDb } from "../../../data/db"
import type { PlayerCharacter } from "../../../data/types"
import {
    getPlayerCharacterSync,
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterSync,
} from "../../../data/domains/character"
import { incrementActiveMissionUsedManaCountSync } from "../../../data/domains/active_mission_counters"
import { recordCollectMissionManaSpend } from "../../mission/collect-battle-facts"
import { getServerTime } from "../../../utils"
import { publishActiveMissionOwnerStateWithinTransaction } from "../../mission/active-publication-owner"
import { settleMissionCategories } from "../../mission/settlement"
import { getMissionCatalog } from "../../mission/mission-catalog"
import { getDegreeMissionIdsForConditionTypes } from "../../mission/degree-candidates"
import { DEGREE_SUPPORTED_FAMILIES } from "../../mission/degree-context-requirements"
import type { MissionSettlementResult } from "../../mission/settlement"
import { recordSecondManaBoardCompletionMilestoneSync } from "../../../lib/player-history-milestones"
import { getPlayerSync, updatePlayerSync } from "../../../data/domains/player"
import { isCharacterSecondManaBoardAvailable } from "../../mana-board-availability"
import { withInventoryBatchContextWithinTransactionSync } from "../../inventory"
import { convergeBondTokenForLearnedBoardWithinTransaction } from "../bond-token-qualification"
import { buildCharacterEvolutionResponse } from "../../character-evolution"
import { createAwakeRequestContext } from "../../mission/awake-request-context"
import { publishAwakeUnlockCharacterListWithStateWithinTransaction } from "../facts/awake-unlock-facts"
import { planLearnManaNodeMutation } from "../../character-mana-mutation-plan"
import type { CharacterGrowthCoreFact, BondTokenStatus } from "../model"
import type { CharacterGrowthCommandResult, CharacterGrowthObservedState } from "../result"
import { createCharacterGrowthRequestContext } from "../request-context"
import { planCharacterGrowthResources } from "../resource-plan"
import {
    applyManaNodePlan,
    assertNormalBoardOwnership,
    boardNodeLevels,
    deriveEvolutionLevel,
} from "../node-state"
import {
    characterLevelFromContent,
    growthMutationError,
    mutationContent,
    requiredItemIds,
    snapshotItems,
    validateEvaluationTime,
    validateNodeCommandIds,
} from "../node-command-support"
import { growthError } from "../errors"
import { MANA_CHARACTER_GROWTH_FIELDS, projectCharacterGrowthIncrement } from "../response-projector"

export interface LearnManaNodesCommand {
    readonly playerId: number
    readonly characterId: number
    readonly requestedNodeIds: readonly number[]
    readonly evaluationTime: Date
}

export interface LearnManaNodesResult extends CharacterGrowthCommandResult {
    readonly after: CharacterGrowthObservedState & {
        readonly bondTokens: ReadonlyMap<number, BondTokenStatus>
        readonly normalManaNodes: ReadonlyMap<number, number>
    }
    readonly bondTokenGranted: boolean
    readonly character: PlayerCharacter
    readonly responseNodeEntries: readonly { readonly multiplied_id: number; readonly awake_level: number }[]
    readonly evolution: Object
    readonly missionFacts: Readonly<{ readonly usedMana: number }>
    readonly activeMissionList: readonly unknown[]
    readonly missionSettlement: MissionSettlementResult | null
    readonly resourceState: Readonly<{
        mana: number
        freeMana: number
        paidMana: number
        items: ReadonlyMap<number, number>
    }>
}

function validateCommand(command: LearnManaNodesCommand): readonly number[] {
    if (!Number.isSafeInteger(command.playerId) || command.playerId <= 0) {
        throw growthError("INVALID_GROWTH_STATE", "playerId must be a positive safe integer.")
    }
    if (!Number.isSafeInteger(command.characterId) || command.characterId <= 0) {
        throw growthError("INVALID_GROWTH_STATE", "characterId must be a positive safe integer.")
    }
    validateEvaluationTime(command.evaluationTime)
    return validateNodeCommandIds(command.requestedNodeIds)
}

function observed(
    character: CharacterGrowthCoreFact,
    bondTokens: ReadonlyMap<number, BondTokenStatus>,
    normalManaNodes: ReadonlyMap<number, number>,
    awakeUnlocks: ReadonlyMap<number, number>,
): CharacterGrowthObservedState {
    return { ...character, bondTokens, normalManaNodes, awakeUnlocks }
}

function finalizeLearnManaAwakePublicationWrites(
    playerId: number,
    characterId: number,
    currentEvolutionLevel: number,
    plannedEvolutionLevel: number,
): void {
    if (plannedEvolutionLevel !== currentEvolutionLevel) {
        updatePlayerCharacterSync(playerId, characterId, {
            evolutionLevel: plannedEvolutionLevel,
        })
    }
}

export function executeLearnManaNodes(command: LearnManaNodesCommand): LearnManaNodesResult {
    const requestedNodeIds = validateCommand(command)
    return getDb().transaction(() => {
        const context = createCharacterGrowthRequestContext({
            playerId: command.playerId,
            characterId: command.characterId,
        })
        const character = context.character()
        const beforeBondTokens = context.bondTokens()
        const beforeNormalManaNodes = context.normalManaNodes()
        const beforeAwakeUnlocks = context.awakeUnlocks()
        const boardId = character.manaBoardIndex
        if (boardId === 2 && !isCharacterSecondManaBoardAvailable(command.characterId, command.evaluationTime)) {
            throw growthError("BOARD_NOT_AVAILABLE", "second mana board is not available.")
        }
        assertNormalBoardOwnership(character, boardId)
        const content = mutationContent(command.characterId, boardId)
        const boardLevels = boardNodeLevels(beforeNormalManaNodes, content)
        const level = characterLevelFromContent(command.characterId, character.rarity, character.exp)
        const itemIds = requiredItemIds(content, requestedNodeIds)
        const player = getPlayerSync(command.playerId)
        if (player === null) throw growthError("INVALID_GROWTH_STATE", "player is unavailable.")
        const settlement = withInventoryBatchContextWithinTransactionSync({
            playerId: command.playerId,
            preloadItemIds: itemIds,
        }, inventory => {
            const itemBalances = new Map(
                inventory.readMany(itemIds).map(item => [item.itemId, item.beforeAmount]),
            )
            let plan
            try {
                plan = planLearnManaNodeMutation({
                    characterId: command.characterId,
                    boardId,
                    characterRarity: character.rarity,
                    characterLevel: level,
                    requestedNodeIds,
                    content,
                    snapshot: {
                        mana: player.freeMana + player.paidMana,
                        items: snapshotItems(itemBalances),
                        nodeAwakeLevels: Object.fromEntries(boardLevels),
                    },
                })
            } catch (error) {
                growthMutationError(error)
            }
            const resources = planCharacterGrowthResources({
                mutationPlan: plan,
                freeMana: player.freeMana,
                paidMana: player.paidMana,
                itemBalances,
            })
            const nextNodes = applyManaNodePlan(beforeNormalManaNodes, plan)
            const isBoardComplete = [...Object.keys(content.nodes).map(Number)]
                .every(nodeId => nextNodes.has(nodeId))
            const bond = convergeBondTokenForLearnedBoardWithinTransaction(
                command.playerId,
                command.characterId,
                beforeBondTokens,
                {
                    boardIndex: boardId,
                    rarity: character.rarity,
                    exp: character.exp,
                    requiredNodeIds: [...Object.keys(content.nodes).map(Number)],
                    learnedNodeIds: new Set(nextNodes.keys()),
                },
            )
            const boardOneContent = mutationContent(command.characterId, 1)
            const plannedEvolutionLevel = Math.max(
                character.evolutionLevel,
                deriveEvolutionLevel(boardOneContent, nextNodes),
            )
            if (plan.hasResourceWrites) {
                updatePlayerSync({
                    id: command.playerId,
                    freeMana: resources.freeManaAfter,
                    paidMana: resources.paidManaAfter,
                })
                incrementActiveMissionUsedManaCountSync(command.playerId, resources.totalManaCost)
                recordCollectMissionManaSpend(command.playerId, resources.totalManaCost, new Date(getServerTime() * 1000))
                for (const [itemId, amount] of resources.totalItemCosts) {
                    inventory.deduct(itemId, amount)
                }
                inventory.flush()
            }
            return { plan, resources, nextNodes, isBoardComplete, bond, plannedEvolutionLevel }
        })
        const { plan, resources, nextNodes, isBoardComplete, bond, plannedEvolutionLevel } = settlement
        insertPlayerCharacterManaNodesSync(
            command.playerId,
            command.characterId,
            plan.nodeUpdates.map(update => update.nodeId),
        )
        if (boardId === 2 && isBoardComplete) {
            recordSecondManaBoardCompletionMilestoneSync(command.playerId, command.characterId)
        }
        // 学节点是「已学节点集合」事实的产生时点:玛纳板累计强化数
        // (total_released_mana_node_count,任务 37 族)与二板全部强化完成
        // (manaboard_2nd_complete_count,任务 96 族)是状态派生任务,必须在
        // 同事务窄域当场结算,否则奖励被推迟到下次进关/任务页
        // (2026-10-01 时点审计发现 #2:learn 显式 null)。开板数
        // (manaboard_2nd_open_count)由 open_mana_board 的全量结算负责。
        // 板完成同时触发信赖证授予(0→1),任务 39(累计获得信赖之证)与
        // 该角色的好感/二板完成称号(cat5 condition 44/48)随之推进——44 虽在
        // 战斗 finish 白名单内但只覆盖参战角色,48 完全不在白名单,授予动作
        // 又都发生在战斗外,必须在此当场结算。
        const learnMissionIds = [
            ...getMissionCatalog().getDefinitionsByPattern("total_released_mana_node_count"),
            ...getMissionCatalog().getDefinitionsByPattern("manaboard_2nd_complete_count"),
            ...getMissionCatalog().getDefinitionsByPattern("total_obtained_bond_token_count"),
        ].map(definition => definition.missionId)
        // cond48 的角色绑定列(row[15])为空的是全角色聚合族(55000 三条),
        // 同样由二板完成驱动,一并纳入;其余按角色收窄避免全表评估。
        // cond8(degree_proof_of_bond_get_,信赖证累计)与 cond7
        // (degree_manaboard_growth_,板强化总数)同样以学节点/信赖证授予为
        // 唯一事实时点且不在战斗 finish 白名单,一并窄域结算
        // (2026-10-03 全量审计:cat5 三个残留族之二)。
        const bondDegreeMissionIds = getDegreeMissionIdsForConditionTypes(
            [8, 44],
            [command.characterId],
        ).concat(getMissionCatalog().getDefinitions(5).filter(definition => {
            const row = definition.row as readonly unknown[]
            return (String(row[3]) === "48"
                    && (row[15] === undefined || row[15] === null
                        || row[15] === "" || row[15] === "(None)"
                        || String(row[15]) === String(command.characterId)))
                || definition.pattern.startsWith(DEGREE_SUPPORTED_FAMILIES.manaBoardCount)
        }).map(definition => definition.missionId))
        const missionSettlement = settleMissionCategories(
            command.playerId,
            [
                { category: 1, missionIds: learnMissionIds },
                ...(bondDegreeMissionIds.length > 0
                    ? [{ category: 5, missionIds: bondDegreeMissionIds }]
                    : []),
            ],
            command.evaluationTime,
        )
        finalizeLearnManaAwakePublicationWrites(
            command.playerId,
            command.characterId,
            character.evolutionLevel,
            plannedEvolutionLevel,
        )

        const afterCore = {
            ...character,
            evolutionLevel: plannedEvolutionLevel,
        }
        const awakeContext = createAwakeRequestContext({
            playerId: command.playerId,
            candidateCharacterIds: [command.characterId],
        })
        const characterData = getPlayerCharacterSync(command.playerId, command.characterId)
        if (characterData === null) throw growthError("INVALID_GROWTH_STATE", "character disappeared during growth.")
        const nextBondTokens = new Map(beforeBondTokens)
        if (bond.bondTokenGranted) nextBondTokens.set(boardId, 1)
        const afterBeforeAwakeReconciliation = observed(
            afterCore,
            nextBondTokens,
            nextNodes,
            beforeAwakeUnlocks,
        )
        const publication = publishAwakeUnlockCharacterListWithStateWithinTransaction(
            command.playerId,
            projectCharacterGrowthIncrement(
                { after: afterBeforeAwakeReconciliation, changedNodeIds: [] },
                { character: characterData, fields: MANA_CHARACTER_GROWTH_FIELDS },
            ).character_list,
            awakeContext,
            [command.characterId],
        )
        const afterAwakeUnlocks = new Map(
            Object.entries(publication.all.get(String(command.characterId)) ?? {})
                .map(([boardIndex, awakeLevel]) => [Number(boardIndex), awakeLevel]),
        )
        const after = observed(
            afterCore,
            nextBondTokens,
            nextNodes,
            afterAwakeUnlocks,
        ) as LearnManaNodesResult["after"]
        const activeMission = publishActiveMissionOwnerStateWithinTransaction({
            playerId: command.playerId,
            now: command.evaluationTime,
            source: "character-growth/learn-mana-nodes",
        })
        return {
            command: "learn_mana_nodes",
            before: observed(character, beforeBondTokens, beforeNormalManaNodes, beforeAwakeUnlocks),
            after,
            changedNodeIds: [...plan.nodeUpdates].map(update => update.nodeId),
            resourceState: {
                mana: resources.manaAfter,
                freeMana: resources.freeManaAfter,
                paidMana: resources.paidManaAfter,
                items: resources.itemsAfter,
            },
            missionSettlement,
            missionFacts: { usedMana: resources.totalManaCost },
            activeMissionList: activeMission.activeMissionList,
            replayed: false,
            bondTokenGranted: bond.bondTokenGranted,
            character: characterData,
            responseNodeEntries: plan.responseNodeEntries,
            evolution: buildCharacterEvolutionResponse(
                command.characterId,
                character.evolutionLevel,
                plannedEvolutionLevel,
            ),
        }
    })()
}

export const learnManaNodes = executeLearnManaNodes
