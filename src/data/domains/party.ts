import { getDb } from "../db";
import { PartyCategory, PlayerParty, PlayerPartyGroup, RawPlayerParty, RawPlayerPartyGroup } from "../types";
import { deserializeBoolean, serializeBoolean } from "../utils";

export function getPlayerPartyGroupListSync(
    playerId: number,
    category: PartyCategory = PartyCategory.NORMAL
): Record<string, PlayerPartyGroup> {
    const db = getDb();
    const rawPartyGroups = db.prepare(`
    SELECT id, color_id, category
    FROM players_party_groups
    WHERE player_id = ? AND category = ?
    `).all(playerId, category) as RawPlayerPartyGroup[]

    const rawParties = db.prepare(`
    SELECT slot, name, character_id_1, character_id_2, character_id_3, unison_character_1,
        unison_character_2, unison_character_3, equipment_1, equipment_2, equipment_3,
        ability_soul_1, ability_soul_2, ability_soul_3, edited, group_id, category,
        current_battle_power, before_battle_power
    FROM players_parties
    WHERE player_id = ? AND category = ?
    `).all(playerId, category) as RawPlayerParty[]

    const groupLists: Record<string, Record<string, PlayerParty>> = {}
    for (const rawParty of rawParties) {
        const groupId = rawParty.group_id.toString()
        let bucket: Record<string, PlayerParty> = groupLists[groupId]
        if (!bucket) {
            bucket = {}
            groupLists[groupId] = bucket
        }
        bucket[rawParty.slot.toString()] = {
            name: rawParty.name,
            characterIds: [rawParty.character_id_1, rawParty.character_id_2, rawParty.character_id_3],
            unisonCharacterIds: [rawParty.unison_character_1, rawParty.unison_character_2, rawParty.unison_character_3],
            equipmentIds: [rawParty.equipment_1, rawParty.equipment_2, rawParty.equipment_3],
            abilitySoulIds: [rawParty.ability_soul_1, rawParty.ability_soul_2, rawParty.ability_soul_3],
            edited: deserializeBoolean(rawParty.edited),
            options: {
                allowOtherPlayersToHealMe: true
            },
            category: rawParty.category,
            currentBattlePower: rawParty.current_battle_power ?? 0,
            beforeBattlePower: rawParty.before_battle_power ?? 0
        }
    }

    const final: Record<string, PlayerPartyGroup> = {}
    for (const rawPartyGroup of rawPartyGroups) {
        const id = rawPartyGroup.id.toString()
        final[id] = {
            list: groupLists[id] || [],
            colorId: rawPartyGroup.color_id,
            category: rawPartyGroup.category
        }
    }
    return final
}

function insertPlayerPartySync(playerId: number, slot: number | string, groupId: number | string, party: PlayerParty) {
    const db = getDb();
    db.prepare(`
    INSERT INTO players_parties (slot, name, character_id_1, character_id_2, character_id_3, 
        unison_character_1, unison_character_2, unison_character_3, equipment_1, equipment_2,
        equipment_3, ability_soul_1, ability_soul_2, ability_soul_3, edited, player_id, group_id, category,
        current_battle_power, before_battle_power)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        Number(slot), party.name,
        party.characterIds[0] || null, party.characterIds[1] || null, party.characterIds[2] || null,
        party.unisonCharacterIds[0] || null, party.unisonCharacterIds[1] || null, party.unisonCharacterIds[2] || null,
        party.equipmentIds[0] || null, party.equipmentIds[1] || null, party.equipmentIds[2] || null,
        party.abilitySoulIds[0] || null, party.abilitySoulIds[1] || null, party.abilitySoulIds[2] || null,
        serializeBoolean(party.edited), playerId, Number(groupId), party.category,
        party.currentBattlePower ?? 0, party.beforeBattlePower ?? 0
    )
}

function insertPlayerPartyGroupSync(playerId: number, groupId: number | string, group: PlayerPartyGroup) {
    const db = getDb();
    db.prepare(`
    INSERT INTO players_party_groups (id, color_id, player_id, category)
    VALUES (?, ?, ?, ?)
    `).run(Number(groupId), group.colorId, playerId, group.category)

    for (const [slot, party] of Object.entries(group.list)) {
        insertPlayerPartySync(playerId, slot, groupId, party)
    }
}

export function insertPlayerPartyGroupListSync(playerId: number, groups: Record<string, PlayerPartyGroup>) {
    const db = getDb();
    db.transaction(() => {
        for (const [groupId, group] of Object.entries(groups)) {
            insertPlayerPartyGroupSync(playerId, groupId, group)
        }
    })()
}

export function updatePlayerPartySync(playerId: number, slot: number, party: PlayerParty, groupId: number = 1) {
    const db = getDb();
    // Upsert: try update first, insert if not exists
    const result = db.prepare(`
    UPDATE players_parties SET name = ?, character_id_1 = ?, character_id_2 = ?, character_id_3 = ?,
        unison_character_1 = ?, unison_character_2 = ?, unison_character_3 = ?,
        equipment_1 = ?, equipment_2 = ?, equipment_3 = ?,
        ability_soul_1 = ?, ability_soul_2 = ?, ability_soul_3 = ?, edited = ?,
        current_battle_power = ?, before_battle_power = ?
    WHERE slot = ? AND player_id = ? AND group_id = ? AND category = ?
    `).run(
        party.name,
        party.characterIds[0], party.characterIds[1], party.characterIds[2],
        party.unisonCharacterIds[0], party.unisonCharacterIds[1], party.unisonCharacterIds[2],
        party.equipmentIds[0], party.equipmentIds[1], party.equipmentIds[2],
        party.abilitySoulIds[0], party.abilitySoulIds[1], party.abilitySoulIds[2],
        serializeBoolean(party.edited),
        party.currentBattlePower ?? 0, party.beforeBattlePower ?? 0,
        slot, playerId, groupId, party.category
    )
    if (result.changes === 0) {
        // Ensure group exists
        const groupExists = db.prepare('SELECT id FROM players_party_groups WHERE id = ? AND player_id = ? AND category = ?').get(groupId, playerId, party.category)
        if (!groupExists) {
            db.prepare('INSERT INTO players_party_groups (id, color_id, player_id, category) VALUES (?, ?, ?, ?)').run(groupId, 0, playerId, party.category)
        }
        insertPlayerPartySync(playerId, slot, groupId, party)
    }
}

export function updatePlayerPartyGroupSync(
    playerId: number, groupId: number, colorId: number,
    category: PartyCategory = PartyCategory.NORMAL
) {
    const db = getDb();
    db.prepare(`
    UPDATE players_party_groups SET color_id = ?
    WHERE id = ? AND player_id = ? AND category = ?
    `).run(colorId, groupId, playerId, category)
}
