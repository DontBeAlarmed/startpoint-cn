import type { PlayerParty } from "../data/types"

export function buildPartyWriteParameters(
    playerId: number,
    groupId: number | string,
    slot: number | string,
    party: PlayerParty,
) {
    return {
        slot: Number(slot),
        name: party.name,
        character_id_1: party.characterIds[0] || null,
        character_id_2: party.characterIds[1] || null,
        character_id_3: party.characterIds[2] || null,
        unison_character_1: party.unisonCharacterIds[0] || null,
        unison_character_2: party.unisonCharacterIds[1] || null,
        unison_character_3: party.unisonCharacterIds[2] || null,
        equipment_1: party.equipmentIds[0] || null,
        equipment_2: party.equipmentIds[1] || null,
        equipment_3: party.equipmentIds[2] || null,
        ability_soul_1: party.abilitySoulIds[0] || null,
        ability_soul_2: party.abilitySoulIds[1] || null,
        ability_soul_3: party.abilitySoulIds[2] || null,
        edited: party.edited ? 1 : 0,
        player_id: playerId,
        group_id: Number(groupId),
        category: party.category,
        current_battle_power: party.currentBattlePower ?? 0,
        before_battle_power: party.beforeBattlePower ?? 0,
    }
}

export const PARTY_WRITE_VALUES = `
    @slot, @name, @character_id_1, @character_id_2, @character_id_3,
    @unison_character_1, @unison_character_2, @unison_character_3,
    @equipment_1, @equipment_2, @equipment_3,
    @ability_soul_1, @ability_soul_2, @ability_soul_3,
    @edited, @player_id, @group_id, @category,
    @current_battle_power, @before_battle_power
`
