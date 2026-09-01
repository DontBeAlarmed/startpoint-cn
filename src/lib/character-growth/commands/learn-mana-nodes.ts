import { getDb } from "../../../data/db"
import type { PlayerCharacter } from "../../../data/types"
import {
    getPlayerCharacterSync,
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterSync,
} from "../../../data/domains/character"
import { incrementActiveMissionUsedManaCountSync } from "../../../data/domains/active_mission_counters"
import { recordSecondManaBoardCompletionMilestoneSync } from "../../../lib/player-history-milestones"
import { getPlayerSync, updatePlayerSync } from "../../../data/domains/player"
import { setPlayerItemWithinTransactionSync } from "../../../data/domains/item"
import { isCharacterSecondManaBoardAvailable } from "../../mana-board-availability"
import {
    updateBondTokenForCompletedBoardFromGrowthState,
} from "../../character-helpers"
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
        const itemBalances = context.requiredItems(itemIds)

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
                    items: snapshotItems(context, itemIds),
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
        const isBoardComplete = [...Object.keys(content.nodes).map(Number)].every(nodeId => nextNodes.has(nodeId))
        const bond = updateBondTokenForCompletedBoardFromGrowthState(
            command.playerId,
            command.characterId,
            beforeBondTokens,
            boardId,
            isBoardComplete,
        )
        const boardOneContent = mutationContent(command.characterId, 1)
        const plannedEvolutionLevel = deriveEvolutionLevel(boardOneContent, nextNodes)
        if (plan.hasResourceWrites) {
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
        }
        insertPlayerCharacterManaNodesSync(
            command.playerId,
            command.characterId,
            plan.nodeUpdates.map(update => update.nodeId),
        )
        if (boardId === 2 && isBoardComplete) {
            recordSecondManaBoardCompletionMilestoneSync(command.playerId, command.characterId)
        }
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
            missionSettlement: null,
            missionFacts: { usedMana: resources.totalManaCost },
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
