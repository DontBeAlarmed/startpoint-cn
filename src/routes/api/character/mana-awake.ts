import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import {
    getPlayerCharactersManaNodeAwakeLevelsSync,
    updatePlayerCharacterManaNodeAwakeLevelSync,
    updatePlayerCharacterSync,
} from "../../../data/domains/character"
import { getPlayerCharacterAwakeUnlocksSync } from "../../../data/domains/character_awake"
import { updatePlayerItemSync } from "../../../data/domains/item"
import { updatePlayerSync } from "../../../data/domains/player"
import { getDb } from "../../../data/db"
import { incrementActiveMissionUsedManaCountSync } from "../../../data/domains/active_mission_counters"
import { getCharacterDataSync, getCharacterManaNodesSync, getManaNodeAwakeCost } from "../../../lib/assets"
import {
    buildCharacterEvolutionNodes,
    buildCharacterEvolutionResponse,
    computeCharacterEvolutionLevel,
} from "../../../lib/character-evolution"
import {
    buildCharacterListEntry,
    computeItemDeductions,
    computeManaDeduction,
    sendCharacterResponse,
    validateCharacterOwnership,
    validateManaBoardAwakeRequest,
    validateSessionAndPlayer,
} from "../../../lib/character-helpers"
import { getMailArrivedSync } from "../../../lib/mail-notification"

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

        const board1Nodes = getCharacterManaNodesSync(characterId, 1)
        if (!board1Nodes) return reply.status(400).send({
            "error": "Bad Request", "message": "Character does not have an awake mana board."
        })
        const board1NodeIds = Object.keys(board1Nodes).map(Number)
        const charAwakeLevels = getPlayerCharactersManaNodeAwakeLevelsSync(playerId)[String(characterId)] ?? {}
        const unlockedAwakeLevel = getPlayerCharacterAwakeUnlocksSync(playerId)
            .get(String(characterId))?.[1] ?? 0
        const learnedNodeIds = Object.keys(charAwakeLevels).map(Number)
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

        let manaCost = 0
        const itemsCosts: Record<string, number> = {}
        const userCharacterManaNodeListItem: { multiplied_id: number; awake_level: number }[] = []
        const nodeUpdates: { nodeId: number; awakeLevel: number }[] = []
        const finalAwakeLevels = new Map(Object.entries(charAwakeLevels).map(([nodeId, level]) => [
            Number(nodeId),
            level,
        ]))
        const learnedNodeSet = new Set(learnedNodeIds)

        const charAssetData = getCharacterDataSync(characterId)
        if (charAssetData === null) return reply.status(400).send({
            "error": "Bad Request", "message": `Character asset data not found for ID ${characterId}.`
        })

        for (const manaNodeId of toAwakenNodeIds) {
            if (!learnedNodeSet.has(manaNodeId)) return reply.status(400).send({
                "error": "Bad Request", "message": `Mana node '${manaNodeId}' is not unlocked.`
            })

            const currentAwakeLevel = charAwakeLevels[manaNodeId] ?? 0
            if (currentAwakeLevel >= targetAwakeLevel) {
                userCharacterManaNodeListItem.push({
                    "multiplied_id": manaNodeId,
                    "awake_level": currentAwakeLevel,
                })
                continue
            }

            const cost = getManaNodeAwakeCost(characterId, manaNodeId, charAssetData.rarity)
            if (cost === null) return reply.status(400).send({
                "error": "Bad Request", "message": `No awake cost found for node '${manaNodeId}' (rarity=${charAssetData.rarity}).`
            })
            manaCost += cost.manaAmount
            for (const [itemId, itemCost] of Object.entries(cost.items)) {
                itemsCosts[itemId] = (itemsCosts[itemId] ?? 0) + itemCost
            }
            userCharacterManaNodeListItem.push({
                "multiplied_id": manaNodeId,
                "awake_level": targetAwakeLevel,
            })
            nodeUpdates.push({ nodeId: manaNodeId, awakeLevel: targetAwakeLevel })
            finalAwakeLevels.set(manaNodeId, targetAwakeLevel)
        }

        const evolutionNodes = buildCharacterEvolutionNodes(board1Nodes)
        const computeFinalEvolutionLevel = () => computeCharacterEvolutionLevel({
            nodes: evolutionNodes,
            learnedNodeIds: learnedNodeSet,
            awakeLevels: finalAwakeLevels,
        })
        const manaBoardAwake = board1NodeIds.every(nodeId => (
            (finalAwakeLevels.get(nodeId) ?? 0) >= targetAwakeLevel
        )) ? { "1": targetAwakeLevel } : undefined

        const noOpEvolutionLevel = nodeUpdates.length === 0
            ? computeFinalEvolutionLevel()
            : null
        if (noOpEvolutionLevel === characterData.evolutionLevel) {
            console.log(`[MANA] awake_mana_node: all nodes at level ${targetAwakeLevel}, returning current state`)
            return sendCharacterResponse(reply, viewerId, {
                user_info: { free_mana: player.freeMana, paid_mana: player.paidMana },
                character_list: [buildCharacterListEntry(characterId, characterData, {
                    ...(manaBoardAwake ? { mana_board_awake: manaBoardAwake } : {}),
                    evolution_level: noOpEvolutionLevel,
                    evolution_img_level: noOpEvolutionLevel,
                })],
                user_character_mana_node_list: { [String(characterId)]: userCharacterManaNodeListItem },
                item_list: {},
                evolution: [],
                mail_arrived: getMailArrivedSync(playerId),
            })
        }

        const manaResult = computeManaDeduction(player, manaCost)
        if (!manaResult) return reply.status(400).send({ "error": "Bad Request", "message": "Not enough mana." })
        const { newFreeMana, newPaidMana } = manaResult
        const newItemAmounts = computeItemDeductions(playerId, itemsCosts, reply)
        if (!newItemAmounts) return

        const characterEvolutionLevel = getDb().transaction(() => {
            updatePlayerSync({ id: playerId, freeMana: newFreeMana, paidMana: newPaidMana })
            incrementActiveMissionUsedManaCountSync(playerId, manaCost)
            for (const [itemId, newAmount] of Object.entries(newItemAmounts)) {
                updatePlayerItemSync(playerId, itemId, newAmount)
            }
            for (const update of nodeUpdates) {
                updatePlayerCharacterManaNodeAwakeLevelSync(
                    playerId,
                    characterId,
                    update.nodeId,
                    update.awakeLevel,
                )
            }
            const finalEvolutionLevel = computeFinalEvolutionLevel()
            if (finalEvolutionLevel !== characterData.evolutionLevel) {
                updatePlayerCharacterSync(playerId, characterId, {
                    evolutionLevel: finalEvolutionLevel,
                })
            }
            return finalEvolutionLevel
        })()
        const evolutionData = buildCharacterEvolutionResponse(
            characterId,
            characterData.evolutionLevel,
            characterEvolutionLevel,
        )

        console.log(`[MANA] awake_mana_node done: manaCost=${manaCost} nodes=${toAwakenNodeIds.length} manaBoardAwake=${!!manaBoardAwake}`)
        return sendCharacterResponse(reply, viewerId, {
            user_info: { free_mana: newFreeMana, paid_mana: newPaidMana },
            character_list: [buildCharacterListEntry(characterId, characterData, {
                ...(manaBoardAwake ? { mana_board_awake: manaBoardAwake } : {}),
                evolution_level: characterEvolutionLevel,
                evolution_img_level: characterEvolutionLevel,
            })],
            user_character_mana_node_list: { [String(characterId)]: userCharacterManaNodeListItem },
            item_list: newItemAmounts,
            evolution: evolutionData,
            mail_arrived: getMailArrivedSync(playerId),
        })
    })
}
