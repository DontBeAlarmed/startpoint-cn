import { getDb } from "../../../data/db"
import {
    updatePlayerCharacterManaNodeAwakeLevelsBatchSync,
    updatePlayerCharacterSync,
} from "../../../data/domains/character"
import { incrementActiveMissionUsedManaCountSync } from "../../../data/domains/active_mission_counters"
import { getPlayerSync, updatePlayerSync } from "../../../data/domains/player"
import { setPlayerItemWithinTransactionSync } from "../../../data/domains/item"
import { getManaNodeAwakeCost } from "../../assets"
import { buildCharacterEvolutionResponse } from "../../character-evolution"
import type { BondTokenStatus, CharacterGrowthCoreFact } from "../model"
import type { CharacterGrowthCommandResult, CharacterGrowthObservedState } from "../result"
import { createCharacterGrowthRequestContext } from "../request-context"
import { planAwakeManaNodeMutation } from "../../character-mana-mutation-plan"
import { planCharacterGrowthResources } from "../resource-plan"
import {
    applyManaNodePlan,
    assertBoardComplete,
    boardNodeLevels,
    deriveEvolutionLevel,
    deriveManaBoardAwake,
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

export interface AwakeManaNodesCommand {
    readonly playerId: number
    readonly characterId: number
    readonly requestedNodeIds: readonly number[]
    readonly targetAwakeLevel: number
    readonly evaluationTime: Date
}

export interface AwakeManaNodesResult extends CharacterGrowthCommandResult {
    readonly after: CharacterGrowthObservedState & {
        readonly bondTokens: ReadonlyMap<number, BondTokenStatus>
        readonly normalManaNodes: ReadonlyMap<number, number>
    }
    readonly characterList: readonly Record<string, unknown>[]
    readonly evolution: Object
    readonly manaBoardAwake: Record<number, number> | undefined
    readonly responseNodeEntries: readonly { readonly multiplied_id: number; readonly awake_level: number }[]
    readonly missionFacts: Readonly<{ readonly usedMana: number }>
}

function validateCommand(command: AwakeManaNodesCommand): readonly number[] {
    if (!Number.isSafeInteger(command.playerId) || command.playerId <= 0) {
        throw growthError("INVALID_GROWTH_STATE", "playerId must be a positive safe integer.")
    }
    if (!Number.isSafeInteger(command.characterId) || command.characterId <= 0) {
        throw growthError("INVALID_GROWTH_STATE", "characterId must be a positive safe integer.")
    }
    if (!Number.isSafeInteger(command.targetAwakeLevel) || command.targetAwakeLevel <= 0) {
        throw growthError("INVALID_AWAKE_TARGET", "target awake level must be positive.")
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

export function executeAwakeManaNodes(command: AwakeManaNodesCommand): AwakeManaNodesResult {
    const requestedNodeIds = validateCommand(command)
    return getDb().transaction(() => {
        const context = createCharacterGrowthRequestContext({
            playerId: command.playerId,
            characterId: command.characterId,
        })
        const character = context.character()
        const content = mutationContent(command.characterId, 1)
        const boardOneNodeIds = new Set(Object.keys(content.nodes).map(Number))
        for (const nodeId of requestedNodeIds) {
            if (!boardOneNodeIds.has(nodeId)) {
                throw growthError("UNKNOWN_NODE", `node ${nodeId} is not on Awake board one.`)
            }
        }
        const allNodeLevels = context.normalManaNodes()
        assertBoardComplete(allNodeLevels, content)
        const unlockedAwakeLevel = context.awakeUnlocks().get(1) ?? 0
        if (unlockedAwakeLevel <= 0 || command.targetAwakeLevel !== unlockedAwakeLevel) {
            throw growthError("INVALID_AWAKE_TARGET", "target awake level is not unlocked.")
        }
        const boardLevels = boardNodeLevels(allNodeLevels, content)
        const player = getPlayerSync(command.playerId)
        if (player === null) throw growthError("INVALID_GROWTH_STATE", "player is unavailable.")
        const awakeCosts: Record<string, { manaCost: number; items: Record<string, number> }> = {}
        for (const nodeId of requestedNodeIds) {
            if ((boardLevels.get(nodeId) ?? 0) >= command.targetAwakeLevel) continue
            const cost = getManaNodeAwakeCost(command.characterId, nodeId, character.rarity)
            if (cost === null) {
                throw growthError("AWAKE_COST_MISSING", `awake cost for node ${nodeId} is unavailable.`)
            }
            awakeCosts[String(nodeId)] = {
                manaCost: cost.manaAmount,
                items: cost.items,
            }
        }
        const itemIds = requiredItemIds(content, requestedNodeIds, awakeCosts)
        const itemBalances = context.requiredItems(itemIds)
        const level = characterLevelFromContent(command.characterId, character.rarity, character.exp)
        let plan
        try {
            plan = planAwakeManaNodeMutation({
                characterId: command.characterId,
                boardId: 1,
                characterRarity: character.rarity,
                characterLevel: level,
                requestedNodeIds,
                targetAwakeLevel: command.targetAwakeLevel,
                awakeCosts,
                content,
                snapshot: {
                    mana: player.freeMana + player.paidMana,
                    items: snapshotItems(context, itemIds),
                    nodeAwakeLevels: Object.fromEntries(boardLevels),
                },
            })
        } catch (error) {
            growthMutationError(error)
        }
        const nextNodes = applyManaNodePlan(allNodeLevels, plan)
        const plannedEvolutionLevel = deriveEvolutionLevel(content, nextNodes)
        const manaBoardAwake = deriveManaBoardAwake(nextNodes, content, command.targetAwakeLevel)
        const before = observed(character, context.bondTokens(), allNodeLevels, context.awakeUnlocks())

        let resources
        if (plan.hasResourceWrites) {
            resources = planCharacterGrowthResources({
                mutationPlan: plan,
                freeMana: player.freeMana,
                paidMana: player.paidMana,
                itemBalances,
            })
            updatePlayerSync({
                id: command.playerId,
                freeMana: resources.freeManaAfter,
                paidMana: resources.paidManaAfter,
            })
            incrementActiveMissionUsedManaCountSync(command.playerId, resources.totalManaCost)
            for (const [itemId, amount] of resources.itemsAfter) {
                setPlayerItemWithinTransactionSync(
                    command.playerId,
                    itemId,
                    amount,
                    resources.itemsBefore.has(itemId),
                )
            }
            updatePlayerCharacterManaNodeAwakeLevelsBatchSync(
                command.playerId,
                command.characterId,
                plan.nodeUpdates,
            )
        }
        if (plannedEvolutionLevel !== character.evolutionLevel) {
            updatePlayerCharacterSync(command.playerId, command.characterId, {
                evolutionLevel: plannedEvolutionLevel,
            })
        }
        const after = observed(
            { ...character, evolutionLevel: plannedEvolutionLevel },
            context.bondTokens(),
            nextNodes,
            context.awakeUnlocks(),
        ) as AwakeManaNodesResult["after"]
        return {
            command: "awake_mana_nodes",
            before,
            after,
            changedNodeIds: plan.nodeUpdates.map(update => update.nodeId),
            ...(resources ? {
                resourceState: {
                    mana: resources.manaAfter,
                    freeMana: resources.freeManaAfter,
                    paidMana: resources.paidManaAfter,
                    items: resources.itemsAfter,
                },
            } : {}),
            missionSettlement: null,
            missionFacts: { usedMana: resources?.totalManaCost ?? 0 },
            replayed: false,
            characterList: [],
            responseNodeEntries: plan.responseNodeEntries,
            evolution: buildCharacterEvolutionResponse(
                command.characterId,
                character.evolutionLevel,
                plannedEvolutionLevel,
            ),
            manaBoardAwake,
        }
    })()
}

export const awakeManaNodes = executeAwakeManaNodes
