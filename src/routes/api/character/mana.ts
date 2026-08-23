// Character mana node endpoints — learn and awake

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { insertPlayerCharacterManaNodesSync, getPlayerCharactersManaNodeAwakeLevelsSync, updatePlayerCharacterSync } from "../../../data/domains/character"
import { getPlayerItemsSync, setPlayerItemWithinTransactionSync } from "../../../data/domains/item"
import { updatePlayerSync } from "../../../data/domains/player"
import { getDb } from "../../../data/db";
import { incrementActiveMissionUsedManaCountSync } from "../../../data/domains/active_mission_counters"
import { validateSessionAndPlayer, validateCharacterOwnership, computeManaDeduction, buildCharacterListEntry, sendCharacterResponse, updateBondTokenForCompletedBoard } from "../../../lib/character-helpers";
import { getMailArrivedSync } from "../../../lib/mail-notification";
import { reconcileAwakeUnlockCharacterListStrict } from "../../../lib/mission";
import { createAwakeRequestContext } from "../../../lib/mission";
import { isCharacterSecondManaBoardAvailable } from "../../../lib/mana-board-availability";
import { buildCharacterEvolutionNodes, buildCharacterEvolutionResponse, computeCharacterEvolutionLevel } from "../../../lib/character-evolution";
import { registerAwakeManaNodeRoute } from "./mana-awake";
import { getContentSnapshot } from "../../../content/runtime/content-snapshot"
import { parseCharacterLevelTable, getCharacterLevelByExperience } from "../../../content/character-mana-admission"
import { buildCharacterManaMutationContent } from "../../../lib/character-mana-mutation-content"
import {
    ManaNodeMutationValidationError,
    planLearnManaNodeMutation,
} from "../../../lib/character-mana-mutation-plan"
import { sendManaMutationError } from "./mana-mutation-http"
import type { ManaNodes } from "../../../lib/types"

interface LearnManaNodeBody {
    viewer_id: number,
    character_id: number,
    api_count: number,
    mana_node_multiplied_id_list: number[]
}

const routes = async (fastify: FastifyInstance) => {

    fastify.post("/learn_mana_node", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as LearnManaNodeBody

        const viewerId = body.viewer_id
        const characterId = body.character_id
        const toUnlockNodeIds = body.mana_node_multiplied_id_list
        console.log(`[MANA] learn_mana_node: viewer=${viewerId} char=${characterId} nodes=${JSON.stringify(toUnlockNodeIds)}`)
        if (!viewerId || isNaN(viewerId) || !characterId || isNaN(characterId) || !toUnlockNodeIds) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const sess = await validateSessionAndPlayer(viewerId, reply)
        if (!sess) return
        const { playerId, player } = sess

        const characterData = validateCharacterOwnership(playerId, characterId, reply)
        if (!characterData) return

        const currentManaNodeIndex = characterData.manaBoardIndex;
        if (currentManaNodeIndex === 2 && !isCharacterSecondManaBoardAvailable(characterId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Second mana board is not available."
            })
        }
        const snapshot = getContentSnapshot()
        const repository = snapshot.repository
        let mutationContent
        try {
            mutationContent = buildCharacterManaMutationContent(characterId, currentManaNodeIndex, {
                manaNodes: repository.table<ManaNodes>("mana_node.json"),
                manaBoard: repository.table<unknown>("mana_board.json"),
                levelRequirements: repository.table<unknown>("level_required_mana_node.json"),
            })
        } catch (error) {
            if (sendManaMutationError(reply, error)) return
            throw error
        }
        const characterAssetData = repository.table<Record<string, {
            rarity: number
        }>>("character.json")[String(characterId)]
        if (!characterAssetData) {
            const contentError = new ManaNodeMutationValidationError(
                "CONTENT_INVALID",
                `Character asset data not found for ID ${characterId}.`,
            )
            sendManaMutationError(reply, contentError)
            return
        }
        if (!Number.isSafeInteger(characterAssetData.rarity)
            || characterAssetData.rarity < 1 || characterAssetData.rarity > 5) {
            const contentError = new ManaNodeMutationValidationError(
                "CONTENT_INVALID",
                `Character rarity is invalid for ID ${characterId}.`,
            )
            sendManaMutationError(reply, contentError)
            return
        }
        if (!Number.isSafeInteger(characterData.exp) || characterData.exp < 0) {
            const snapshotError = new ManaNodeMutationValidationError(
                "SNAPSHOT_INVALID",
                `Character experience is invalid for ID ${characterId}.`,
            )
            sendManaMutationError(reply, snapshotError)
            return
        }
        let levelTable
        try {
            levelTable = parseCharacterLevelTable(repository.table("character_level.json"))
        } catch (error) {
            const contentError = new ManaNodeMutationValidationError(
                "CONTENT_INVALID",
                error instanceof Error ? error.message : String(error),
            )
            sendManaMutationError(reply, contentError)
            return
        }
        let characterLevel
        try {
            characterLevel = getCharacterLevelByExperience(
                levelTable,
                characterAssetData.rarity,
                characterData.exp,
            )
        } catch (error) {
            const snapshotError = new ManaNodeMutationValidationError(
                "SNAPSHOT_INVALID",
                error instanceof Error ? error.message : String(error),
            )
            sendManaMutationError(reply, snapshotError)
            return
        }
        const allCharacterAwakeLevels = getPlayerCharactersManaNodeAwakeLevelsSync(playerId)
        const persistedAwakeLevels = allCharacterAwakeLevels[String(characterId)] ?? {}
        const currentBoardNodeIds = new Set(Object.keys(mutationContent.nodes))
        const currentBoardAwakeLevels = Object.fromEntries(
            Object.entries(persistedAwakeLevels).filter(([nodeId]) => currentBoardNodeIds.has(nodeId)),
        )
        const playerItems = getPlayerItemsSync(playerId)
        let plan
        try {
            plan = planLearnManaNodeMutation({
                characterId,
                boardId: currentManaNodeIndex,
                characterRarity: characterAssetData.rarity,
                characterLevel,
                requestedNodeIds: toUnlockNodeIds,
                content: mutationContent,
                snapshot: {
                    mana: player.freeMana + player.paidMana,
                    items: playerItems,
                    nodeAwakeLevels: currentBoardAwakeLevels,
                },
            })
        } catch (error) {
            if (sendManaMutationError(reply, error)) return
            throw error
        }

        const manaResult = computeManaDeduction(player, plan.totalManaCost)
        if (!manaResult) return reply.status(400).send({ "error": "Bad Request", "message": "Not enough mana." })
        const { newFreeMana, newPaidMana } = manaResult
        const newItemAmounts = Object.fromEntries(
            Object.entries(plan.totalItemCosts).map(([itemId, cost]) => [
                itemId,
                (playerItems[itemId] ?? 0) - cost,
            ]),
        )
        const isBoardComplete = Object.keys(mutationContent.nodes).every(nodeId => (
            plan.finalLearnedNodeIds.includes(Number(nodeId))
        ))
        const firstBoardManaNodes = repository.table<ManaNodes>("mana_node.json")[String(characterId)]?.["1"]
        if (!firstBoardManaNodes) {
            const contentError = new ManaNodeMutationValidationError(
                "CONTENT_INVALID",
                "Character does not have a first mana board.",
            )
            sendManaMutationError(reply, contentError)
            return
        }
        const finalLearnedNodeIds = new Set([
            ...Object.keys(persistedAwakeLevels).map(Number),
            ...plan.nodeUpdates.map(update => update.nodeId),
        ])
        const finalAwakeLevels = new Map(
            Object.entries(persistedAwakeLevels).map(([nodeId, level]) => [Number(nodeId), level] as const),
        )
        for (const [nodeId, level] of Object.entries(plan.finalAwakeLevels)) {
            finalAwakeLevels.set(Number(nodeId), level)
        }
        const plannedCharacterEvolutionLevel = computeCharacterEvolutionLevel({
            nodes: buildCharacterEvolutionNodes(firstBoardManaNodes),
            learnedNodeIds: finalLearnedNodeIds,
            awakeLevels: finalAwakeLevels,
        })
        const transactionResult = getDb().transaction(() => {
            updatePlayerSync({ id: playerId, freeMana: newFreeMana, paidMana: newPaidMana })
            incrementActiveMissionUsedManaCountSync(playerId, plan.totalManaCost)
            for (const [itemId, newAmount] of Object.entries(newItemAmounts)) {
                setPlayerItemWithinTransactionSync(
                    playerId,
                    itemId,
                    newAmount,
                    Object.prototype.hasOwnProperty.call(playerItems, itemId),
                )
            }

            insertPlayerCharacterManaNodesSync(
                playerId,
                characterId,
                plan.nodeUpdates.map(update => update.nodeId),
            )
            const bond = updateBondTokenForCompletedBoard(
                playerId, characterId, characterData, currentManaNodeIndex, isBoardComplete
            )
            if (plannedCharacterEvolutionLevel !== characterData.evolutionLevel) {
                updatePlayerCharacterSync(playerId, characterId, {
                    evolutionLevel: plannedCharacterEvolutionLevel,
                })
            }
            const awakeContext = createAwakeRequestContext({
                playerId,
                candidateCharacterIds: [characterId],
            })
            const characterList = reconcileAwakeUnlockCharacterListStrict(playerId, [
                buildCharacterListEntry(characterId, characterData, {
                    evolution_level: plannedCharacterEvolutionLevel,
                    evolution_img_level: plannedCharacterEvolutionLevel,
                    bond_token_list: bond.bondTokenList,
                }),
            ], {
                context: awakeContext,
                candidateCharacterIds: [characterId],
            })

            return {
                ...bond,
                characterEvolutionLevel: plannedCharacterEvolutionLevel,
                evolutionData: buildCharacterEvolutionResponse(
                    characterId,
                    characterData.evolutionLevel,
                    plannedCharacterEvolutionLevel,
                ),
                characterList,
            }
        })()
        const {
            characterEvolutionLevel,
            evolutionData,
            bondTokenList,
            characterList,
        } = transactionResult

        console.log(`[MANA] learn_mana_node done: boardComplete=${isBoardComplete} bondGiven=${transactionResult.bondTokenGranted} evoLevel=${characterEvolutionLevel}`)

        return sendCharacterResponse(reply, viewerId, {
            user_info: { free_mana: newFreeMana, paid_mana: newPaidMana },
            character_list: characterList,
            user_character_mana_node_list: { [String(characterId)]: [...plan.responseNodeEntries] },
            item_list: newItemAmounts,
            evolution: evolutionData,
            mail_arrived: getMailArrivedSync(playerId),
        })
    })

    registerAwakeManaNodeRoute(fastify)
}

export default routes;
