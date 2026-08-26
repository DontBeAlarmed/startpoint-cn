export interface BattleHistoryProtocolRecord {
    readonly ability_soul_id_1: number | null
    readonly ability_soul_id_2: number | null
    readonly ability_soul_id_3: number | null
    readonly category_id: number
    readonly character_1_total_damage: number | null
    readonly character_2_total_damage: number | null
    readonly character_3_total_damage: number | null
    readonly character_id_1: number | null
    readonly character_id_2: number | null
    readonly character_id_3: number | null
    readonly clear_rank: number | null
    readonly create_time: string
    readonly elapsed_time_ms: number
    readonly enhancement_level_1: number | null
    readonly enhancement_level_2: number | null
    readonly enhancement_level_3: number | null
    readonly equipment1_id: number | null
    readonly equipment2_id: number | null
    readonly equipment3_id: number | null
    readonly equipment_level_1: number | null
    readonly equipment_level_2: number | null
    readonly equipment_level_3: number | null
    readonly finish_kind: number
    readonly quest_id: number
    readonly score: number | null
    readonly total_damage: number
    readonly unison_character_id_1: number | null
    readonly unison_character_id_2: number | null
    readonly unison_character_id_3: number | null
}

export const BATTLE_HISTORY_COLUMNS = `
    ability_soul_id_1, ability_soul_id_2, ability_soul_id_3,
    category_id,
    character_1_total_damage, character_2_total_damage, character_3_total_damage,
    character_id_1, character_id_2, character_id_3,
    clear_rank, create_time, elapsed_time_ms,
    enhancement_level_1, enhancement_level_2, enhancement_level_3,
    equipment1_id, equipment2_id, equipment3_id,
    equipment_level_1, equipment_level_2, equipment_level_3,
    finish_kind, quest_id, score, total_damage,
    unison_character_id_1, unison_character_id_2, unison_character_id_3
`

export const BATTLE_HISTORY_VALUES = `
    @ability_soul_id_1, @ability_soul_id_2, @ability_soul_id_3,
    @category_id,
    @character_1_total_damage, @character_2_total_damage, @character_3_total_damage,
    @character_id_1, @character_id_2, @character_id_3,
    @clear_rank, @create_time, @elapsed_time_ms,
    @enhancement_level_1, @enhancement_level_2, @enhancement_level_3,
    @equipment1_id, @equipment2_id, @equipment3_id,
    @equipment_level_1, @equipment_level_2, @equipment_level_3,
    @finish_kind, @quest_id, @score, @total_damage,
    @unison_character_id_1, @unison_character_id_2, @unison_character_id_3
`

export function battleHistoryProtocolParameters(record: BattleHistoryProtocolRecord) {
    return {
        ability_soul_id_1: record.ability_soul_id_1,
        ability_soul_id_2: record.ability_soul_id_2,
        ability_soul_id_3: record.ability_soul_id_3,
        category_id: record.category_id,
        character_1_total_damage: record.character_1_total_damage,
        character_2_total_damage: record.character_2_total_damage,
        character_3_total_damage: record.character_3_total_damage,
        character_id_1: record.character_id_1,
        character_id_2: record.character_id_2,
        character_id_3: record.character_id_3,
        clear_rank: record.clear_rank,
        create_time: record.create_time,
        elapsed_time_ms: record.elapsed_time_ms,
        enhancement_level_1: record.enhancement_level_1,
        enhancement_level_2: record.enhancement_level_2,
        enhancement_level_3: record.enhancement_level_3,
        equipment1_id: record.equipment1_id,
        equipment2_id: record.equipment2_id,
        equipment3_id: record.equipment3_id,
        equipment_level_1: record.equipment_level_1,
        equipment_level_2: record.equipment_level_2,
        equipment_level_3: record.equipment_level_3,
        finish_kind: record.finish_kind,
        quest_id: record.quest_id,
        score: record.score,
        total_damage: record.total_damage,
        unison_character_id_1: record.unison_character_id_1,
        unison_character_id_2: record.unison_character_id_2,
        unison_character_id_3: record.unison_character_id_3,
    }
}
