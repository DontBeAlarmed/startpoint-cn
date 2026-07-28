// Character mana node endpoints — learn and awake

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerCharacterManaNodesSync, getPlayerCharacterSync, getPlayerCharactersManaNodesSync, hasPlayerUnlockedCharacterManaNodeSync, insertPlayerCharacterManaNodesSync, getPlayerCharactersManaNodeAwakeLevelsSync, updatePlayerCharacterManaNodeAwakeLevelSync } from "../../../data/domains/character"
import { getPlayerCharacterAwakeUnlocksSync } from "../../../data/domains/character_awake"
import { getPlayerItemSync, updatePlayerItemSync } from "../../../data/domains/item"
import { getPlayerSync, updatePlayerSync } from "../../../data/domains/player"
import { getSession } from "../../../data/domains/session"
import { getCharacterDataSync, getCharacterManaNodesSync, getManaNodeAwakeCost } from "../../../lib/assets";
import { clientSerializeDate } from "../../../data/utils";
import { resolvePlayerIdSync } from "../../../data/activeAccount";
import { getDb } from "../../../data/db";
import { incrementActiveMissionUsedManaCountSync } from "../../../data/domains/active_mission_counters"
import { validateSessionAndPlayer, validateCharacterOwnership, computeManaDeduction, computeItemDeductions, buildCharacterListEntry, sendCharacterResponse, computeBondTokenAndEvolution, validateManaBoardAwakeRequest } from "../../../lib/character-helpers";
import { getMailArrivedSync } from "../../../lib/mail-notification";
import { reconcileAwakeUnlockCharacterList } from "../../../lib/mission";
import { isCharacterSecondManaBoardAvailable } from "../../../lib/mana-board-availability";

interface LearnManaNodeBody {
    viewer_id: number,
    character_id: number,
    api_count: number,
    mana_node_multiplied_id_list: number[]
}

interface AwakeManaNodeBody {
    viewer_id: number,
    character_id: number,
    api_count: number,
    mana_node_multiplied_id_list: number[],
    awake_level: number
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

        const unlockedManaNodes = getPlayerCharacterManaNodesSync(playerId, characterId);
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
        const transactionResult = getDb().transaction(() => {
            updatePlayerSync({ id: playerId, freeMana: newFreeMana, paidMana: newPaidMana })
            incrementActiveMissionUsedManaCountSync(playerId, manaCost)
            for (const [itemId, newAmount] of Object.entries(newItemAmounts)) {
                updatePlayerItemSync(playerId, itemId, newAmount)
            }

            const bond = computeBondTokenAndEvolution(
                playerId, characterId, characterData, currentManaNodeIndex, isBoardComplete
            )
            insertPlayerCharacterManaNodesSync(playerId, characterId, toUnlockNodeIds)
            const characterList = reconcileAwakeUnlockCharacterList(playerId, [
                buildCharacterListEntry(characterId, characterData, {
                    evolution_level: bond.characterEvolutionLevel,
                    evolution_img_level: bond.characterEvolutionLevel,
                    bond_token_list: bond.bondTokenList,
                }),
            ])

            return { ...bond, characterList }
        })()
        const {
            characterEvolutionLevel,
            evolutionData,
            bondTokenList,
            characterList,
        } = transactionResult

        console.log(`[MANA] learn_mana_node done: boardComplete=${isBoardComplete} bondGiven=${!!bondTokenList.length} evoLevel=${characterEvolutionLevel}`)

        return sendCharacterResponse(reply, viewerId, {
            user_info: { free_mana: newFreeMana, paid_mana: newPaidMana },
            character_list: characterList,
            user_character_mana_node_list: { [String(characterId)]: userCharacterManaNodeListItem as { multiplied_id: number; awake_level: number }[] },
            item_list: newItemAmounts,
            evolution: evolutionData,
            mail_arrived: getMailArrivedSync(playerId),
        })
    })

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

        const board1Nodes = getCharacterManaNodesSync(characterId, 1)
        if (!board1Nodes) return reply.status(400).send({
            "error": "Bad Request", "message": "Character does not have an awake mana board."
        })
        const board1NodeIds = Object.keys(board1Nodes).map(Number)
        const awakeLevels = getPlayerCharactersManaNodeAwakeLevelsSync(playerId)
        const charAwakeLevels = awakeLevels[String(characterId)] ?? {}
        const unlockedAwakeMap = getPlayerCharacterAwakeUnlocksSync(playerId)
        const unlockedAwakeLevel = unlockedAwakeMap.get(String(characterId))?.[1] ?? 0
        const learnedNodeIds = getPlayerCharactersManaNodesSync(playerId)[String(characterId)] ?? []
        const validationError = validateManaBoardAwakeRequest(
            toAwakenNodeIds,
            targetAwakeLevel,
            unlockedAwakeLevel,
            board1NodeIds,
            learnedNodeIds
        )
        if (validationError) return reply.status(400).send({
            "error": "Bad Request", "message": validationError
        })

        // Compute costs for each awakening node
        let manaCost = 0
        const itemsCosts: Record<string, number> = {}
        const userCharacterManaNodeListItem: Object[] = []

        // Cache character rarity outside the loop
        const charAssetData = getCharacterDataSync(characterId)
        if (charAssetData === null) return reply.status(400).send({
            "error": "Bad Request", "message": `Character asset data not found for ID ${characterId}.`
        })
        const rarity = charAssetData.rarity

        for (const manaNodeId of toAwakenNodeIds) {
            if (!hasPlayerUnlockedCharacterManaNodeSync(playerId, characterId, manaNodeId)) return reply.status(400).send({
                "error": "Bad Request", "message": `Mana node '${manaNodeId}' is not unlocked.`
            })

            const currentAwakeLevel = charAwakeLevels[manaNodeId] ?? 0
            if (currentAwakeLevel >= targetAwakeLevel) {
                userCharacterManaNodeListItem.push({ "multiplied_id": manaNodeId, "awake_level": currentAwakeLevel })
                continue
            }

            const cost = getManaNodeAwakeCost(characterId, manaNodeId, rarity)
            if (cost === null) return reply.status(400).send({
                "error": "Bad Request", "message": `No awake cost found for node '${manaNodeId}' (rarity=${rarity}).`
            })

            manaCost += cost.manaAmount
            for (const [itemId, itemCost] of Object.entries(cost.items)) {
                itemsCosts[itemId] = (itemsCosts[itemId] ?? 0) + itemCost
            }
            userCharacterManaNodeListItem.push({ "multiplied_id": manaNodeId, "awake_level": targetAwakeLevel })
        }

        // All nodes already at target — return current state
        if (manaCost === 0) {
            // Check if ALL board 1 nodes are at target level
            let manaBoardAwake: Record<string, number> | undefined
            const totalBoardNodes = board1NodeIds.length
            let awakenedCount = 0
            for (const nid of board1NodeIds) {
                if ((charAwakeLevels[nid] ?? 0) >= targetAwakeLevel) awakenedCount++
            }
            if (awakenedCount === totalBoardNodes) {
                manaBoardAwake = { "1": targetAwakeLevel }
            }
            console.log(`[MANA] awake_mana_node: all nodes at level ${targetAwakeLevel}, returning current state`)
            return sendCharacterResponse(reply, viewerId, {
                user_info: { free_mana: player.freeMana, paid_mana: player.paidMana },
                character_list: [buildCharacterListEntry(characterId, characterData, {
                    ...(manaBoardAwake ? { mana_board_awake: manaBoardAwake } : {}),
                    bond_token_list: (characterData.bondTokenList || []).map((e: any) => ({ mana_board_index: e.manaBoardIndex, status: e.status })),
                })],
                user_character_mana_node_list: { [String(characterId)]: userCharacterManaNodeListItem as { multiplied_id: number; awake_level: number }[] },
                item_list: {},
                evolution: [],
                mail_arrived: getMailArrivedSync(playerId),
            })
        }

        // Deduct mana
        const manaResult = computeManaDeduction(player, manaCost)
        if (!manaResult) return reply.status(400).send({ "error": "Bad Request", "message": "Not enough mana." })
        const { newFreeMana, newPaidMana } = manaResult

        // Deduct items
        const itemResult = computeItemDeductions(playerId, itemsCosts, reply)
        if (!itemResult) return
        const newItemAmounts = itemResult

        getDb().transaction(() => {
            updatePlayerSync({ id: playerId, freeMana: newFreeMana, paidMana: newPaidMana })
            incrementActiveMissionUsedManaCountSync(playerId, manaCost)
            for (const [itemId, newAmount] of Object.entries(newItemAmounts)) {
                updatePlayerItemSync(playerId, itemId, newAmount)
            }

            for (const item of userCharacterManaNodeListItem) {
                const nodeId = (item as any).multiplied_id
                const lvl = (item as any).awake_level
                if (lvl === targetAwakeLevel) {
                    updatePlayerCharacterManaNodeAwakeLevelSync(playerId, characterId, nodeId, targetAwakeLevel)
                }
            }
        })()

        // Only set mana_board_awake if ALL board 1 nodes have reached the target level
        let manaBoardAwake: Record<string, number> | undefined
        const totalBoardNodes = board1NodeIds.length
        const updatedAwakeLevels = getPlayerCharactersManaNodeAwakeLevelsSync(playerId)
        const charLevels = updatedAwakeLevels[String(characterId)] ?? {}
        let awakenedCount = 0
        for (const nid of board1NodeIds) {
            if ((charLevels[nid] ?? 0) >= targetAwakeLevel) awakenedCount++
        }
        if (awakenedCount === totalBoardNodes) {
            manaBoardAwake = { "1": targetAwakeLevel }
        }

        console.log(`[MANA] awake_mana_node done: manaCost=${manaCost} nodes=${toAwakenNodeIds.length} manaBoardAwake=${!!manaBoardAwake}`)
        return sendCharacterResponse(reply, viewerId, {
            user_info: { free_mana: newFreeMana, paid_mana: newPaidMana },
            character_list: [buildCharacterListEntry(characterId, characterData, {
                ...(manaBoardAwake ? { mana_board_awake: manaBoardAwake } : {}),
            })],
            user_character_mana_node_list: { [String(characterId)]: userCharacterManaNodeListItem as { multiplied_id: number; awake_level: number }[] },
            item_list: newItemAmounts,
            evolution: [],
            mail_arrived: getMailArrivedSync(playerId),
        })
    })
}

export default routes;
