// Tracks party member co-clears (pairwise) for multi-character awake missions
// When 3+ specific characters must be in the same party, this tracks their co-appearances

import { getDb } from "../../../data/db"
import { incrementPlayerCategoryMissionSync } from "../../../data/domains/mission"
import {
    getMatchedAwakeDirectBattleMissionIds,
    normalizeCharacterPair,
} from "../../mission/awake-battle-rules"
import { getCharacterRaces, getRaceKeyString } from "./race-utils"
import type { FinishContext } from "./types"

export function trackPartyCoClears(ctx: FinishContext): void {
    const ids: number[] = []
    const allRaces: string[] = []
    for (const c of ctx.party.characters) {
        if (c?.id) {
            ids.push(c.id)
            allRaces.push(...getCharacterRaces(c.id))
        }
    }
    for (const c of ctx.party.unison_characters) {
        if (c?.id) {
            ids.push(c.id)
            allRaces.push(...getCharacterRaces(c.id))
        }
    }

    // Co-clears (pairwise character IDs)
    const unique = [...new Set(ids)].sort((a, b) => a - b)
    if (unique.length >= 2) {
        const db = getDb()
        const insert = db.prepare(`
        INSERT INTO players_party_member_co_clears (player_id, char_id_a, char_id_b, co_clear_count)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(player_id, char_id_a, char_id_b) DO UPDATE SET
            co_clear_count = co_clear_count + 1
        `)
        const tx = db.transaction(() => {
            for (let i = 0; i < unique.length - 1; i++) {
                for (let j = i + 1; j < unique.length; j++) {
                    const [charIdA, charIdB] = normalizeCharacterPair(unique[i], unique[j])
                    insert.run(ctx.playerId, charIdA, charIdB)
                }
            }
        })
        tx()
    }

    // Race clears (unique race set)
    const raceKey = getRaceKeyString(allRaces)
    if (raceKey) {
        getDb().prepare(`
        INSERT INTO players_party_race_clears (player_id, race_key, clear_count)
        VALUES (?, ?, 1)
        ON CONFLICT(player_id, race_key) DO UPDATE SET
            clear_count = clear_count + 1
        `).run(ctx.playerId, raceKey)
    }

    for (const missionId of getMatchedAwakeDirectBattleMissionIds(ctx, raceKey)) {
        incrementPlayerCategoryMissionSync(ctx.playerId, 9, missionId, 1)
    }
}
