import type { PlayerEquipment } from "../../data/types"
import type { BattleHistoryProtocolRecord } from "../../data/domains/battle-history"
import { clientSerializeDate } from "../../data/utils"

export interface HistoryParty {
    readonly characters?: readonly ({ readonly id?: unknown } | null)[]
    readonly unison_characters?: readonly ({ readonly id?: unknown } | null)[]
    readonly equipments?: readonly ({ readonly id?: unknown } | null)[]
    readonly ability_soul_ids?: readonly unknown[]
}

export interface HistoryStatistics {
    readonly zones?: readonly {
        readonly damage_deal_total?: unknown
        readonly members?: readonly ({ readonly origin_damage?: unknown } | null)[]
    }[]
}

export interface BuildBattleHistoryInput {
    readonly categoryId: number
    readonly questId: number
    readonly finishKind: number
    readonly createdAt: Date
    readonly elapsedTimeMs: number
    readonly score: number | null
    readonly clearRank: number | null
    readonly party: HistoryParty
    readonly statistics: HistoryStatistics
    readonly equipmentList: Readonly<Record<string, PlayerEquipment>>
}

function requiredNonNegativeNumber(value: unknown, field: string, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${label} ${field} must be a finite non-negative number`)
    }
    return value
}

function optionalPositiveInteger(value: unknown, field: string, label: string): number | null {
    if (value === undefined || value === null) return null
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
        throw new Error(`${label} ${field} must be a positive integer or null`)
    }
    return Number(value)
}

function optionalNonNegativeInteger(value: unknown, field: string, label: string): number | null {
    if (value === undefined || value === null) return null
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new Error(`${label} ${field} must be a non-negative integer or null`)
    }
    return Number(value)
}

function sumMemberDamage(
    zones: NonNullable<HistoryStatistics["zones"]>,
    memberIndex: number,
    label: string,
): number | null {
    let found = false
    let total = 0
    for (const [zoneIndex, zone] of zones.entries()) {
        const value = zone.members?.[memberIndex]?.origin_damage
        if (value === undefined || value === null) continue
        total += requiredNonNegativeNumber(
            value,
            `statistics.zones[${zoneIndex}].members[${memberIndex}].origin_damage`,
            label,
        )
        if (!Number.isFinite(total)) throw new Error(`${label} member damage overflow`)
        found = true
    }
    return found ? total : null
}

export function buildBattleHistoryProtocolRecord(
    input: BuildBattleHistoryInput,
    expectedCategory: number,
    label: string,
): BattleHistoryProtocolRecord {
    if (input.categoryId !== expectedCategory
        || !Number.isSafeInteger(input.questId) || input.questId <= 0
        || !Number.isSafeInteger(input.finishKind) || input.finishKind < 0
        || !Number.isFinite(input.createdAt.getTime())) {
        throw new Error(`${label} identity is invalid`)
    }
    const elapsedTimeMs = requiredNonNegativeNumber(input.elapsedTimeMs, "elapsed_time_ms", label)
    const score = input.score === null
        ? null
        : requiredNonNegativeNumber(input.score, "score", label)
    const clearRank = optionalNonNegativeInteger(input.clearRank, "clear_rank", label)
    const zones = input.statistics.zones
    if (!Array.isArray(zones) || zones.length === 0) {
        throw new Error(`${label} statistics.zones must not be empty`)
    }
    let totalDamage = 0
    for (const [index, zone] of zones.entries()) {
        totalDamage += requiredNonNegativeNumber(
            zone.damage_deal_total,
            `statistics.zones[${index}].damage_deal_total`,
            label,
        )
        if (!Number.isFinite(totalDamage)) throw new Error(`${label} total damage overflow`)
    }

    const characters = [0, 1, 2].map(index => optionalPositiveInteger(
        input.party.characters?.[index]?.id,
        `character_id_${index + 1}`,
        label,
    ))
    const unisons = [0, 1, 2].map(index => optionalPositiveInteger(
        input.party.unison_characters?.[index]?.id,
        `unison_character_id_${index + 1}`,
        label,
    ))
    const equipments = [0, 1, 2].map(index => optionalPositiveInteger(
        input.party.equipments?.[index]?.id,
        `equipment${index + 1}_id`,
        label,
    ))
    const abilitySouls = [0, 1, 2].map(index => optionalPositiveInteger(
        input.party.ability_soul_ids?.[index],
        `ability_soul_id_${index + 1}`,
        label,
    ))
    const equipmentSnapshots = equipments.map((equipmentId, index) => {
        if (equipmentId === null) return null
        const equipment = input.equipmentList[String(equipmentId)]
        if (!equipment) throw new Error(`${label} equipment${index + 1}_id is not owned`)
        return equipment
    })

    return {
        ability_soul_id_1: abilitySouls[0],
        ability_soul_id_2: abilitySouls[1],
        ability_soul_id_3: abilitySouls[2],
        category_id: input.categoryId,
        character_1_total_damage: sumMemberDamage(zones, 0, label),
        character_2_total_damage: sumMemberDamage(zones, 1, label),
        character_3_total_damage: sumMemberDamage(zones, 2, label),
        character_id_1: characters[0],
        character_id_2: characters[1],
        character_id_3: characters[2],
        clear_rank: clearRank,
        create_time: clientSerializeDate(input.createdAt),
        elapsed_time_ms: elapsedTimeMs,
        enhancement_level_1: equipmentSnapshots[0]?.enhancementLevel ?? null,
        enhancement_level_2: equipmentSnapshots[1]?.enhancementLevel ?? null,
        enhancement_level_3: equipmentSnapshots[2]?.enhancementLevel ?? null,
        equipment1_id: equipments[0],
        equipment2_id: equipments[1],
        equipment3_id: equipments[2],
        equipment_level_1: equipmentSnapshots[0]?.level ?? null,
        equipment_level_2: equipmentSnapshots[1]?.level ?? null,
        equipment_level_3: equipmentSnapshots[2]?.level ?? null,
        finish_kind: input.finishKind,
        quest_id: input.questId,
        score,
        total_damage: totalDamage,
        unison_character_id_1: unisons[0],
        unison_character_id_2: unisons[1],
        unison_character_id_3: unisons[2],
    }
}
