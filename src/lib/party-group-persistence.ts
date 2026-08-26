import { Database as BetterSqlite3Database } from "better-sqlite3"
import { PartyCategory, PlayerParty, PlayerPartyGroup } from "../data/types"
import { buildPartyWriteParameters, PARTY_WRITE_VALUES } from "./party-write-parameters"

const PRUNED_SPECIAL_EVENT_CATEGORIES = [PartyCategory.CARNIVAL, PartyCategory.RUSH]
const MAX_SPECIAL_EVENT_PARTY_GROUP_ID = 6

export function pruneSpecialEventPartyGroupsSync(db: BetterSqlite3Database): void {
    const placeholders = PRUNED_SPECIAL_EVENT_CATEGORIES.map(() => "?").join(",")
    db.prepare(`
        DELETE FROM players_parties
        WHERE category IN (${placeholders}) AND group_id > ?
    `).run(...PRUNED_SPECIAL_EVENT_CATEGORIES, MAX_SPECIAL_EVENT_PARTY_GROUP_ID)
    db.prepare(`
        DELETE FROM players_party_groups
        WHERE category IN (${placeholders}) AND id > ?
    `).run(...PRUNED_SPECIAL_EVENT_CATEGORIES, MAX_SPECIAL_EVENT_PARTY_GROUP_ID)
}

function insertMissingPartySync(
    db: BetterSqlite3Database,
    playerId: number,
    groupId: number | string,
    slot: number | string,
    party: PlayerParty,
) {
    db.prepare(`
    INSERT OR IGNORE INTO players_parties (slot, name, character_id_1, character_id_2, character_id_3,
        unison_character_1, unison_character_2, unison_character_3, equipment_1, equipment_2,
        equipment_3, ability_soul_1, ability_soul_2, ability_soul_3, edited, player_id, group_id, category,
        current_battle_power, before_battle_power)
    VALUES (${PARTY_WRITE_VALUES})
    `).run(buildPartyWriteParameters(playerId, groupId, slot, party))
}

export function insertMissingPartyGroupListSync(
    db: BetterSqlite3Database,
    playerId: number,
    groups: Record<string, PlayerPartyGroup>,
) {
    const insertGroup = db.prepare(`
    INSERT OR IGNORE INTO players_party_groups (id, color_id, player_id, category)
    VALUES (?, ?, ?, ?)
    `)

    db.transaction(() => {
        for (const [groupId, group] of Object.entries(groups)) {
            insertGroup.run(Number(groupId), group.colorId, playerId, group.category)
            for (const [slot, party] of Object.entries(group.list)) {
                insertMissingPartySync(db, playerId, groupId, slot, party)
            }
        }
    })()
}
