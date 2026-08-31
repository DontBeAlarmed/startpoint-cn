// Character endpoint shared helpers — session validation, mana/item deduction

import { FastifyReply } from "fastify"
import type { Player, PlayerCharacter } from "../data/types"
import { getPlayerSync } from "../data/domains/player"
import { getPlayerCharacterSync } from "../data/domains/character"
import { getSession } from "../data/domains/session"
import { resolvePlayerIdSync } from "../data/activeAccount"
import { getPlayerItemSync } from "../data/domains/item"
import { updatePlayerCharacterBondTokenSync } from "../data/domains/character"
import { generateDataHeaders } from "../utils"
import { clientSerializeDate } from "../data/utils/date"
import { getBondTokenStatus, projectSortedBondTokens } from "./character-growth/invariants"
import type { BondTokenStatus } from "./character-growth/model"
import { growthError } from "./character-growth/errors"

// ─── Response types ───

export interface CharacterResponseData {
    user_info: Record<string, unknown>
    character_list: Record<string, unknown>[]
    user_character_mana_node_list: Record<string, { multiplied_id: number; awake_level: number }[]>
    item_list: Record<string, number>
    evolution: Object
    mail_arrived: boolean
    mission_info?: Record<string, unknown>[]
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

export function computeManaDeduction(player: Player, manaCost: number): {
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

// ─── Response builders ───

/** Builds the standard character_list entry for mana-related responses. */
export function buildCharacterListEntry(
    characterId: number,
    characterData: PlayerCharacter,
    extras: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        character_id: characterId,
        evolution_level: characterData.evolutionLevel,
        evolution_img_level: characterData.evolutionLevel,
        create_time: clientSerializeDate(characterData.joinTime),
        update_time: clientSerializeDate(characterData.updateTime),
        join_time: clientSerializeDate(characterData.joinTime),
        bond_token_list: [...characterData.bondTokenList]
            .sort((left, right) => left.manaBoardIndex - right.manaBoardIndex)
            .map(entry => ({
            mana_board_index: entry.manaBoardIndex,
            status: entry.status,
            })),
        ...extras,
    }
}

/** Merges mission-unlocked and persisted mana-board awake levels. */
export function mergeManaBoardAwakeMaps(
    ...maps: Map<string, Record<number, number>>[]
): Map<string, Record<number, number>> {
    const merged = new Map<string, Record<number, number>>()

    for (const map of maps) {
        for (const [characterId, boardLevels] of map) {
            const current = merged.get(characterId) ?? {}
            for (const [boardIndex, awakeLevel] of Object.entries(boardLevels)) {
                const index = Number(boardIndex)
                current[index] = Math.max(current[index] ?? 0, awakeLevel)
            }
            merged.set(characterId, current)
        }
    }

    return merged
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

        result.push({
            character_id: Number(characterId),
            exp: character.exp,
            join_time: clientSerializeDate(character.joinTime),
            update_time: clientSerializeDate(character.updateTime),
            mana_board_awake: { ...manaBoardAwake },
        })
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

// ─── Bond token ───

export interface BondTokenResult {
    bondTokenList: Object[]
    bondTokenGranted: boolean
}

/**
 * Checks board completion and updates the independently earned bond token.
 */
export function updateBondTokenForCompletedBoard(
    playerId: number,
    characterId: number,
    characterData: PlayerCharacter,
    boardIndex: number,
    isBoardComplete: boolean
): BondTokenResult {
    const tokenMap = new Map<number, BondTokenStatus>(characterData.bondTokenList.map(entry => [
        entry.manaBoardIndex,
        entry.status as BondTokenStatus,
    ]))
    const currentStatus = getBondTokenStatus(tokenMap, boardIndex)
    if (currentStatus === null) {
        throw growthError(
            "INVALID_GROWTH_STATE",
            `completed mana board ${boardIndex} is missing its bond token row.`,
        )
    }
    const bondTokenGranted = currentStatus === 0
        && isBoardComplete

    if (bondTokenGranted) {
        updatePlayerCharacterBondTokenSync(playerId, characterId, { manaBoardIndex: boardIndex, status: 1 })
    }

    const nextTokenMap = new Map(tokenMap)
    if (bondTokenGranted) nextTokenMap.set(boardIndex, 1)
    return {
        bondTokenGranted,
        bondTokenList: projectSortedBondTokens(nextTokenMap),
    }
}

/** Sends a standard-format mana-related response. */
export function sendCharacterResponse(
    reply: FastifyReply,
    viewerId: number,
    data: CharacterResponseData
) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        "data_headers": generateDataHeaders({ viewer_id: viewerId }),
        "data": data,
    })
}

// ─── Mana board awake level computation ───

/** Computes persisted mana-board awake levels from node state. */
export function computeManaBoardAwakeFromNodes(
    characterManaNodeAwakeLevels: Record<string, Record<number, number>>
): Map<string, Record<number, number>> {
    const result = new Map<string, Record<number, number>>()
    for (const [charId, nodeLevels] of Object.entries(characterManaNodeAwakeLevels)) {
        let maxLevel = 0
        for (const awakeLevel of Object.values(nodeLevels)) {
            if (awakeLevel > maxLevel) maxLevel = awakeLevel
        }
        if (maxLevel > 0) {
            result.set(charId, { 1: maxLevel })
        }
    }
    return result
}
