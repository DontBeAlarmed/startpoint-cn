import { getDb } from "../data/db"
import {
    getPlayerCharacterManaNodeAwakeLevelsSync,
    getPlayerCharactersSync,
} from "../data/domains/character"
import { getPlayerEquipmentListSync } from "../data/domains/equipment"
import { parseGlobalPartyId } from "./special-event-parties"

/**
 * 开局块加成的编队组成快照（active quest 冻结列的载荷）。
 *
 * 开战（single/multi start）时按 partySlot 指针读取当时编队并冻结：
 * finish 结算读取冻结值计算加成，杜绝"开战后改编队影响本局结算"的
 * 陈旧指针病（同 leader_character_id 家族）。旧行/读取失败 fail-open
 * 为 null，结算回退指针重读（见 resolveFinishOpeningBonus）。
 */
export interface OpeningPartyCompositionCharacter {
    readonly characterId: number
    readonly evolutionLevel: number
    /** {节点 id: 觉醒级} —— players_characters_mana_nodes 投影 */
    readonly manaNodes: Record<string, number>
    readonly equipment: { readonly equipmentId: number; readonly level: number } | null
    readonly abilitySoulId: number | null
}

export interface OpeningPartyComposition {
    readonly version: 1
    /** 按槽位排列；index 0 = 队长（队长能力仅此位生效） */
    readonly characters: readonly OpeningPartyCompositionCharacter[]
}

interface RawPartyCompositionRow {
    character_id_1: number | null
    character_id_2: number | null
    character_id_3: number | null
    equipment_1: number | null
    equipment_2: number | null
    equipment_3: number | null
    ability_soul_1: number | null
    ability_soul_2: number | null
    ability_soul_3: number | null
}

function parseCompositionJson(text: string | null | undefined): OpeningPartyComposition | null {
    if (!text) return null
    try {
        const parsed = JSON.parse(text) as unknown
        if (
            typeof parsed !== "object" || parsed === null
            || (parsed as { version?: unknown }).version !== 1
            || !Array.isArray((parsed as { characters?: unknown }).characters)
        ) {
            return null
        }
        return parsed as OpeningPartyComposition
    } catch {
        return null
    }
}

export function serializeOpeningPartyComposition(
    composition: OpeningPartyComposition,
): string {
    return JSON.stringify(composition)
}

export function parseOpeningPartyComposition(
    text: string | null | undefined,
): OpeningPartyComposition | null {
    return parseCompositionJson(text)
}

/**
 * 按 partySlot 指针读取当前编队，构造开局块加成的组成快照。
 * 任何读取失败返回 null（调用方降级为无加成），不抛出——纯展示/加成
 * 数据不得阻断开战主流程。
 */
export function buildOpeningPartyComposition(
    playerId: number,
    partySlot: number | null | undefined,
): OpeningPartyComposition | null {
    try {
        const parsed = typeof partySlot === "number" ? parseGlobalPartyId(partySlot) : null
        if (parsed === null) return null
        const row = getDb().prepare(`
        SELECT character_id_1, character_id_2, character_id_3,
            equipment_1, equipment_2, equipment_3,
            ability_soul_1, ability_soul_2, ability_soul_3
        FROM players_parties
        WHERE player_id = ? AND group_id = ? AND slot = ? AND category = 1
        `).get(playerId, parsed.groupId, parsed.slot) as RawPartyCompositionRow | undefined
        if (row === undefined) return null

        const characters = getPlayerCharactersSync(playerId)
        const equipments = getPlayerEquipmentListSync(playerId)
        const slots: {
            characterId: number | null
            equipmentId: number | null
            abilitySoulId: number | null
        }[] = [
            {
                characterId: row.character_id_1,
                equipmentId: row.equipment_1,
                abilitySoulId: row.ability_soul_1,
            },
            {
                characterId: row.character_id_2,
                equipmentId: row.equipment_2,
                abilitySoulId: row.ability_soul_2,
            },
            {
                characterId: row.character_id_3,
                equipmentId: row.equipment_3,
                abilitySoulId: row.ability_soul_3,
            },
        ]

        const compositionCharacters: OpeningPartyCompositionCharacter[] = []
        for (const slot of slots) {
            if (typeof slot.characterId !== "number" || slot.characterId <= 0) continue
            const owned = characters[String(slot.characterId)]
            compositionCharacters.push({
                characterId: slot.characterId,
                evolutionLevel: owned?.evolutionLevel ?? 0,
                manaNodes: getPlayerCharacterManaNodeAwakeLevelsSync(
                    playerId,
                    slot.characterId,
                ),
                equipment:
                    typeof slot.equipmentId === "number" && slot.equipmentId > 0
                        ? {
                            equipmentId: slot.equipmentId,
                            level: equipments[String(slot.equipmentId)]?.level ?? 1,
                        }
                        : null,
                abilitySoulId:
                    typeof slot.abilitySoulId === "number" && slot.abilitySoulId > 0
                        ? slot.abilitySoulId
                        : null,
            })
        }
        if (compositionCharacters.length === 0) return null
        return { version: 1, characters: compositionCharacters }
    } catch (error) {
        console.warn("[OPENING] party composition build failed (bonus disabled)", error)
        return null
    }
}
