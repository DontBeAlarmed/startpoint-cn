// Character endpoint shared helpers — session validation, mana/item deduction

import { FastifyReply } from "fastify"
import type { Player, PlayerCharacter } from "../data/types"
import { getPlayerSync } from "../data/domains/player"
import { getPlayerCharacterSync } from "../data/domains/character"
import { getSession } from "../data/domains/session"
import { resolvePlayerIdSync } from "../data/activeAccount"
import { getPlayerItemSync } from "../data/domains/item"
import { generateDataHeaders } from "../utils"
import { projectCharacterPatch, projectEquipmentPatch } from "./common-response/entities"
import { mergeCommonResponseFragments } from "./common-response/merge"
import {
    characterGrowthProjectionStateFromPlayerCharacter,
    projectCharacterGrowthEntry,
} from "./character-growth/response-projector"

export { computeManaBoardAwakeFromNodes, mergeManaBoardAwakeMaps } from "./character-mana-board-maps"

// ─── Response types ───

export interface CharacterResponseData {
    user_info: Record<string, unknown>
    character_list: Record<string, unknown>[]
    user_character_mana_node_list: Record<string, { multiplied_id: number; awake_level: number }[]>
    item_list: Record<string, number>
    evolution: Object
    mail_arrived: boolean
    mission_info?: Record<string, unknown>[]
    active_mission_list?: readonly unknown[]
    equipment_list?: Record<string, unknown>[]
    degree_list?: Record<string, unknown>[]
}

// ─── Shared validation ───

export interface ValidatedSession {
    viewerId: number
    playerId: number
    player: Player
}

/** Validates session + player existence. Sends 400/500 on failure. */
export async function validateSessionAndPlayer(
    viewerId: number,
    reply: FastifyReply
): Promise<ValidatedSession | null> {
    const session = await getSession(viewerId.toString())
    if (!session) {
        reply.status(400).send({ "error": "Bad Request", "message": "Invalid viewer id." })
        return null
    }
    const playerId = resolvePlayerIdSync(session.accountId)!
    const player = getPlayerSync(playerId)
    if (!player) {
        reply.status(500).send({ "error": "Internal Server Error", "message": "No players bound to account." })
        return null
    }
    return { viewerId, playerId, player }
}

export interface ValidatedCharacter extends ValidatedSession {
    characterId: number
    characterData: PlayerCharacter
}

/** Validates character ownership. Sends 400 on failure. */
export function validateCharacterOwnership(
    playerId: number,
    characterId: number,
    reply: FastifyReply
): PlayerCharacter | null {
    const characterData = getPlayerCharacterSync(playerId, characterId)
    if (!characterData) {
        reply.status(400).send({ "error": "Bad Request", "message": "Character not owned." })
        return null
    }
    return characterData
}

// ─── Mana deduction ───

export function computeManaDeduction(player: Pick<Player, "freeMana" | "paidMana">, manaCost: number): {
    newFreeMana: number
    newPaidMana: number
} | null {
    let remaining = manaCost
    let newFreeMana = player.freeMana
    let newPaidMana = player.paidMana
    if (remaining <= newFreeMana) {
        newFreeMana -= remaining
    } else {
        remaining -= newFreeMana
        newFreeMana = 0
        newPaidMana -= remaining
    }
    if (newFreeMana < 0 || newPaidMana < 0) return null
    return { newFreeMana, newPaidMana }
}

// ─── Item deduction ───

/** Validates item availability and computes remaining amounts. Returns null on insufficient. */
export function computeItemDeductions(
    playerId: number,
    itemsCosts: Record<string, number>,
    reply: FastifyReply
): Record<string, number> | null {
    const result: Record<string, number> = {}
    for (const [itemId, itemCost] of Object.entries(itemsCosts)) {
        const item = getPlayerItemSync(playerId, itemId)
        const newAmount = (item ?? 0) - itemCost
        if (newAmount < 0) {
            reply.status(400).send({ "error": "Bad Request", "message": `Not enough of item with id ${itemId}` })
            return null
        }
        result[itemId] = newAmount
    }
    return result
}

/** Builds the minimal common-response entries needed to refresh Awake unlocks. */
export function buildManaBoardAwakeCharacterList(
    characters: Record<string, PlayerCharacter>,
    manaBoardAwakeMap: Map<string, Record<number, number>>
): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = []

    for (const [characterId, manaBoardAwake] of manaBoardAwakeMap) {
        const character = characters[characterId]
        if (!character) continue

        const id = Number(characterId)
        result.push(projectCharacterGrowthEntry({
            characterId: id,
            character,
            state: {
                ...characterGrowthProjectionStateFromPlayerCharacter(id, character),
                awakeUnlocks: new Map(Object.entries(manaBoardAwake).map(([boardIndex, level]) => [
                    Number(boardIndex),
                    level,
                ])),
            },
            fields: ["exp", "join_time", "update_time", "mana_board_awake"],
        }))
    }

    return result
}

export function validateManaBoardAwakeRequest(
    requestedNodeIds: unknown,
    targetAwakeLevel: unknown,
    unlockedAwakeLevel: number,
    boardNodeIds: readonly number[],
    learnedNodeIds: readonly number[]
): string | null {
    if (!Array.isArray(requestedNodeIds) || requestedNodeIds.length === 0
        || requestedNodeIds.some(nodeId => !Number.isInteger(nodeId))
        || new Set(requestedNodeIds).size !== requestedNodeIds.length) {
        return "Invalid mana node list."
    }
    if (unlockedAwakeLevel <= 0) return "Awake missions are not complete."
    if (!Number.isInteger(targetAwakeLevel) || targetAwakeLevel !== unlockedAwakeLevel) {
        return "Invalid awake level."
    }

    const learned = new Set(learnedNodeIds)
    if (boardNodeIds.some(nodeId => !learned.has(nodeId))) {
        return "Base mana board is not complete."
    }
    const board = new Set(boardNodeIds)
    if (requestedNodeIds.some(nodeId => !board.has(nodeId))) {
        return "Mana node is outside the awake board."
    }
    return null
}

/** Sends a standard-format mana-related response. */
export function sendCharacterResponse(
    reply: FastifyReply,
    viewerId: number,
    data: CharacterResponseData
) {
    const {
        user_info,
        character_list,
        item_list,
        mail_arrived,
        mission_info,
        equipment_list,
        ...endpointLocal
    } = data
    const common = mergeCommonResponseFragments([{
        user_info,
        character_list: character_list.map(character => projectCharacterPatch(character)),
        item_list,
        mail_arrived,
        ...(mission_info === undefined ? {} : { mission_info }),
        ...(equipment_list === undefined
            ? {}
            : {
                equipment_list: equipment_list.map(
                    equipment => projectEquipmentPatch(equipment),
                ),
            }),
    }])
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        "data_headers": generateDataHeaders({ viewer_id: viewerId }),
        "data": {
            ...common,
            ...endpointLocal,
        },
    })
}
