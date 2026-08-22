import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import {
    getPlayerCharactersManaNodeAwakeLevelsSync,
    updatePlayerCharacterManaNodeAwakeLevelsBatchSync,
    updatePlayerCharacterSync,
} from "../../../data/domains/character"
import { getPlayerCharacterAwakeUnlocksSync } from "../../../data/domains/character_awake"
import { getPlayerItemsSync, setPlayerItemWithinTransactionSync } from "../../../data/domains/item"
import { updatePlayerSync } from "../../../data/domains/player"
import { getDb } from "../../../data/db"
import { incrementActiveMissionUsedManaCountSync } from "../../../data/domains/active_mission_counters"
import { getManaNodeAwakeCost } from "../../../lib/assets"
import {
    buildCharacterEvolutionNodes,
    buildCharacterEvolutionResponse,
    computeCharacterEvolutionLevel,
} from "../../../lib/character-evolution"
import {
    buildCharacterListEntry,
    computeManaDeduction,
    sendCharacterResponse,
    validateCharacterOwnership,
    validateManaBoardAwakeRequest,
    validateSessionAndPlayer,
} from "../../../lib/character-helpers"
import { getMailArrivedSync } from "../../../lib/mail-notification"
import { getContentSnapshot } from "../../../content/runtime/content-snapshot"
import { parseCharacterLevelTable, getCharacterLevelByExperience } from "../../../content/character-mana-admission"
import { buildCharacterManaMutationContent } from "../../../lib/character-mana-mutation-content"
import {
    ManaNodeMutationValidationError,
    planAwakeManaNodeMutation,
} from "../../../lib/character-mana-mutation-plan"
import { sendManaMutationError } from "./mana-mutation-http"
import type { ManaNodes } from "../../../lib/types"

interface AwakeManaNodeBody {
    viewer_id: number
    character_id: number
    api_count: number
    mana_node_multiplied_id_list: number[]
    awake_level: number
}

export function registerAwakeManaNodeRoute(fastify: FastifyInstance): void {
    fastify.post("/awake_mana_node", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as AwakeManaNodeBody
        const viewerId = body.viewer_id
        const characterId = body.character_id
        const toAwakenNodeIds = body.mana_node_multiplied_id_list
        const targetAwakeLevel = body.awake_level
        console.log(`[MANA] awake_mana_node: viewer=${viewerId} char=${characterId} nodes=${JSON.stringify(toAwakenNodeIds)} level=${targetAwakeLevel}`)
        if (!viewerId || isNaN(viewerId) || !characterId || isNaN(characterId) || !toAwakenNodeIds || !targetAwakeLevel) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const sess = await validateSessionAndPlayer(viewerId, reply)
        if (!sess) return
        const { playerId, player } = sess
        const characterData = validateCharacterOwnership(playerId, characterId, reply)
        if (!characterData) return

        const snapshot = getContentSnapshot()
        const repository = snapshot.repository
        let mutationContent
        try {
            mutationContent = buildCharacterManaMutationContent(characterId, 1, {
                manaNodes: repository.table<ManaNodes>("mana_node.json"),
                manaBoard: repository.table<unknown>("mana_board.json"),
                levelRequirements: repository.table<unknown>("level_required_mana_node.json"),
            })
        } catch (error) {
            if (sendManaMutationError(reply, error)) return
            throw error
        }
        const board1Nodes = mutationContent.nodes
        const board1NodeIds = Object.keys(board1Nodes).map(Number)
        const allCharacterAwakeLevels = getPlayerCharactersManaNodeAwakeLevelsSync(playerId)
        const charAwakeLevels = allCharacterAwakeLevels[String(characterId)] ?? {}
        const currentBoardNodeIds = new Set(Object.keys(board1Nodes))
        const currentBoardAwakeLevels = Object.fromEntries(
            Object.entries(charAwakeLevels).filter(([nodeId]) => currentBoardNodeIds.has(nodeId)),
        )
        const unlockedAwakeLevel = getPlayerCharacterAwakeUnlocksSync(playerId)
            .get(String(characterId))?.[1] ?? 0
        const learnedNodeIds = Object.keys(currentBoardAwakeLevels).map(Number)
        const validationError = validateManaBoardAwakeRequest(
            toAwakenNodeIds,
            targetAwakeLevel,
            unlockedAwakeLevel,
            board1NodeIds,
            learnedNodeIds,
        )
        if (validationError) return reply.status(400).send({
            "error": "Bad Request", "message": validationError
        })

        const charAssetData = repository.table<Record<string, { rarity: number }>>("character.json")[String(characterId)]
        if (!charAssetData) {
            const contentError = new ManaNodeMutationValidationError(
                "CONTENT_INVALID",
                `Character asset data not found for ID ${characterId}.`,
            )
            sendManaMutationError(reply, contentError)
            return
        }
        if (!Number.isSafeInteger(charAssetData.rarity)
            || charAssetData.rarity < 1 || charAssetData.rarity > 5) {
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
                charAssetData.rarity,
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
        const playerItems = getPlayerItemsSync(playerId)
        const awakeCosts: Record<string, { manaCost: number; items: Record<string, number> }> = {}
        for (const manaNodeId of toAwakenNodeIds) {
            if ((currentBoardAwakeLevels[String(manaNodeId)] ?? 0) < targetAwakeLevel) {
                const cost = getManaNodeAwakeCost(characterId, manaNodeId, charAssetData.rarity)
                if (cost === null) {
                    const costError = new ManaNodeMutationValidationError(
                        "AWAKE_COST_MISSING",
                        `No awake cost found for node '${manaNodeId}' (rarity=${charAssetData.rarity}).`,
                    )
                    sendManaMutationError(reply, costError)
                    return
                }
                awakeCosts[String(manaNodeId)] = {
                    manaCost: cost.manaAmount,
                    items: cost.items,
                }
            }
        }
        let plan
        try {
            plan = planAwakeManaNodeMutation({
                characterId,
                boardId: 1,
                characterRarity: charAssetData.rarity,
                characterLevel,
                requestedNodeIds: toAwakenNodeIds,
                targetAwakeLevel,
                awakeCosts,
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
        const finalAwakeLevels = new Map(
            Object.entries(plan.finalAwakeLevels).map(([nodeId, level]) => [Number(nodeId), level] as const),
        )
        const learnedNodeSet = new Set(plan.finalLearnedNodeIds)
        const characterEvolutionLevel = computeCharacterEvolutionLevel({
            nodes: buildCharacterEvolutionNodes(board1Nodes),
            learnedNodeIds: learnedNodeSet,
            awakeLevels: finalAwakeLevels,
        })
        const manaBoardAwake = board1NodeIds.every(nodeId => (
            (finalAwakeLevels.get(nodeId) ?? 0) >= targetAwakeLevel
        )) ? { "1": targetAwakeLevel } : undefined
        const transactionEvolutionLevel = getDb().transaction(() => {
            if (plan.hasResourceWrites) {
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
                updatePlayerCharacterManaNodeAwakeLevelsBatchSync(
                    playerId,
                    characterId,
                    plan.nodeUpdates,
                )
            }
            if (characterEvolutionLevel !== characterData.evolutionLevel) {
                updatePlayerCharacterSync(playerId, characterId, {
                    evolutionLevel: characterEvolutionLevel,
                })
            }
            return characterEvolutionLevel
        })()
        const evolutionData = buildCharacterEvolutionResponse(
            characterId,
            characterData.evolutionLevel,
            transactionEvolutionLevel,
        )

        console.log(`[MANA] awake_mana_node done: manaCost=${plan.totalManaCost} nodes=${toAwakenNodeIds.length} manaBoardAwake=${!!manaBoardAwake}`)
        return sendCharacterResponse(reply, viewerId, {
            user_info: { free_mana: newFreeMana, paid_mana: newPaidMana },
            character_list: [buildCharacterListEntry(characterId, characterData, {
                ...(manaBoardAwake ? { mana_board_awake: manaBoardAwake } : {}),
                evolution_level: transactionEvolutionLevel,
                evolution_img_level: transactionEvolutionLevel,
            })],
            user_character_mana_node_list: { [String(characterId)]: [...plan.responseNodeEntries] },
            item_list: newItemAmounts,
            evolution: evolutionData,
            mail_arrived: getMailArrivedSync(playerId),
        })
    })
}
