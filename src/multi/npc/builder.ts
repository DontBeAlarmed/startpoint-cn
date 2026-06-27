import type {
    MultiMate,
    MultiMatePartyCharacter,
    MultiMateEquipment,
    NpcMateTemplate,
} from "../../lib/types"
import { NPC_TEMPLATES } from "./types"

function buildMateCharacter(id: number): MultiMatePartyCharacter {
    return {
        id,
        evolution_level: 5,
        exp: 0,
        over_limit_step: 0,
        mana_node_ids: [],
        ex_boost: null,
    }
}

function buildMateEquipment(id: number): MultiMateEquipment {
    return {
        equipment_id: id,
        level: 1,
        enhancement_level: 0,
    }
}

function buildNpcMate(template: NpcMateTemplate): MultiMate {
    const characters: (MultiMatePartyCharacter | null)[] = template.characters.map(buildMateCharacter)
    while (characters.length < 3) characters.push(null)

    const unisonCharacters: (MultiMatePartyCharacter | null)[] = template.unison_characters.map(buildMateCharacter)
    while (unisonCharacters.length < 3) unisonCharacters.push(null)

    const equipments: (MultiMateEquipment | null)[] = template.equipments.map(buildMateEquipment)
    while (equipments.length < 3) equipments.push(null)

    const abilitySoulIds: (number | null)[] = [...template.ability_soul_ids]
    while (abilitySoulIds.length < 3) abilitySoulIds.push(null)

    return {
        com_id: template.com_id,
        degree_id: template.degree_id,
        rank: template.rank,
        party: {
            characters,
            unison_characters: unisonCharacters,
            equipments,
            ability_soul_ids: abilitySoulIds,
        },
    }
}

export function buildNpcMates(_questId?: number, _category?: number): { mate1: MultiMate | null, mate2: MultiMate | null } {
    const t1 = NPC_TEMPLATES[0]
    const t2 = NPC_TEMPLATES[1]
    return {
        mate1: t1 ? buildNpcMate(t1) : null,
        mate2: t2 ? buildNpcMate(t2) : null,
    }
}
