// Character mana node endpoints — learn and awake

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { insertPlayerCharacterManaNodesSync, getPlayerCharactersManaNodeAwakeLevelsSync, updatePlayerCharacterSync } from "../../../data/domains/character"
import { updatePlayerItemSync } from "../../../data/domains/item"
import { updatePlayerSync } from "../../../data/domains/player"
import { getCharacterManaNodesSync } from "../../../lib/assets";
import { getDb } from "../../../data/db";
import { incrementActiveMissionUsedManaCountSync } from "../../../data/domains/active_mission_counters"
import { validateSessionAndPlayer, validateCharacterOwnership, computeManaDeduction, computeItemDeductions, buildCharacterListEntry, sendCharacterResponse, updateBondTokenForCompletedBoard } from "../../../lib/character-helpers";
import { getMailArrivedSync } from "../../../lib/mail-notification";
import { reconcileAwakeUnlockCharacterListStrict } from "../../../lib/mission";
import { isCharacterSecondManaBoardAvailable } from "../../../lib/mana-board-availability";
import { buildCharacterEvolutionNodes, buildCharacterEvolutionResponse, computeCharacterEvolutionLevel } from "../../../lib/character-evolution";
import { registerAwakeManaNodeRoute } from "./mana-awake";

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

        // compute the combined cost of each node
        let manaCost = 0
        const itemsCosts: Record<string, number> = {}
        const userCharacterManaNodeListItem: Object[] = []

        const currentManaNodeIndex = characterData.manaBoardIndex;
        if (currentManaNodeIndex === 2 && !isCharacterSecondManaBoardAvailable(characterId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Second mana board is not available."
            })
        }
        const characterManaNodes = getCharacterManaNodesSync(characterId, currentManaNodeIndex)
        if (characterManaNodes === null) return reply.status(400).send({
            "error": "Bad Request", "message": `Character does not have mana nodes of index '${currentManaNodeIndex}'.`
        })

        const characterAwakeLevels = getPlayerCharactersManaNodeAwakeLevelsSync(playerId)[String(characterId)] ?? {}
        const unlockedManaNodes = Object.keys(characterAwakeLevels).map(Number)
        const unlockedManaNodesRecord: Record<string, boolean> = {}
        let indexUnlockedNodesCount = 0
        for (const manaNodeId of unlockedManaNodes) {
            unlockedManaNodesRecord[manaNodeId] = true
            indexUnlockedNodesCount += characterManaNodes[manaNodeId] === undefined ? 0 : 1
        }

        for (const manaNodeId of toUnlockNodeIds) {
            if (unlockedManaNodesRecord[manaNodeId]) return reply.status(400).send({
                "error": "Bad Request", "message": `Mana node '${manaNodeId}' already unlocked.`
            })

            const nodeData = characterManaNodes[manaNodeId];
            if (nodeData === undefined) return reply.status(400).send({
                "error": "Bad Request", "message": `Mana node '${manaNodeId}' does not exist.`
            })

            if (nodeData !== null) {
                manaCost += nodeData.manaCost
                for (const [itemId, itemCost] of Object.entries(nodeData.items)) {
                    itemsCosts[itemId] = (itemsCosts[itemId] ?? 0) + itemCost
                }
                userCharacterManaNodeListItem.push({ "multiplied_id": manaNodeId, "awake_level": 0 })
            }
        }

        // Deduct mana
        const manaResult = computeManaDeduction(player, manaCost)
        if (!manaResult) return reply.status(400).send({ "error": "Bad Request", "message": "Not enough mana." })
        const { newFreeMana, newPaidMana } = manaResult

        // Deduct items
        const itemResult = computeItemDeductions(playerId, itemsCosts, reply)
        if (!itemResult) return
        const newItemAmounts = itemResult

        const isBoardComplete = (indexUnlockedNodesCount + toUnlockNodeIds.length) === Object.keys(characterManaNodes).length
        const firstBoardManaNodes = currentManaNodeIndex === 1
            ? characterManaNodes
            : getCharacterManaNodesSync(characterId, 1)
        if (firstBoardManaNodes === null) return reply.status(400).send({
            "error": "Bad Request", "message": "Character does not have a first mana board."
        })
        const transactionResult = getDb().transaction(() => {
            updatePlayerSync({ id: playerId, freeMana: newFreeMana, paidMana: newPaidMana })
            incrementActiveMissionUsedManaCountSync(playerId, manaCost)
            for (const [itemId, newAmount] of Object.entries(newItemAmounts)) {
                updatePlayerItemSync(playerId, itemId, newAmount)
            }

            insertPlayerCharacterManaNodesSync(playerId, characterId, toUnlockNodeIds)
            const bond = updateBondTokenForCompletedBoard(
                playerId, characterId, characterData, currentManaNodeIndex, isBoardComplete
            )
            const characterEvolutionLevel = computeCharacterEvolutionLevel({
                nodes: buildCharacterEvolutionNodes(firstBoardManaNodes),
                learnedNodeIds: new Set([...unlockedManaNodes, ...toUnlockNodeIds]),
                awakeLevels: new Map(Object.entries(characterAwakeLevels).map(([nodeId, level]) => [
                    Number(nodeId),
                    level,
                ])),
            })
            if (characterEvolutionLevel !== characterData.evolutionLevel) {
                updatePlayerCharacterSync(playerId, characterId, {
                    evolutionLevel: characterEvolutionLevel,
                })
            }
            const characterList = reconcileAwakeUnlockCharacterListStrict(playerId, [
                buildCharacterListEntry(characterId, characterData, {
                    evolution_level: characterEvolutionLevel,
                    evolution_img_level: characterEvolutionLevel,
                    bond_token_list: bond.bondTokenList,
                }),
            ])

            return {
                ...bond,
                characterEvolutionLevel,
                evolutionData: buildCharacterEvolutionResponse(
                    characterId,
                    characterData.evolutionLevel,
                    characterEvolutionLevel,
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
            user_character_mana_node_list: { [String(characterId)]: userCharacterManaNodeListItem as { multiplied_id: number; awake_level: number }[] },
            item_list: newItemAmounts,
            evolution: evolutionData,
            mail_arrived: getMailArrivedSync(playerId),
        })
    })

    registerAwakeManaNodeRoute(fastify)
}

export default routes;
