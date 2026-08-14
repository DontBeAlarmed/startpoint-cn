// Tracks pairwise party history and writes atomic Character Awake battle facts.

import { getDb } from "../../../data/db"
import {
    ensurePlayerCategoryMissionProgressSync,
    incrementPlayerCategoryMissionsIfSafeSync,
} from "../../../data/domains/mission"
import {
    getAwakeBattleProgressFacts,
    normalizeCharacterPair,
} from "../../mission/awake-battle-rules"
import { getCharacterRaces, getRaceKeyString } from "./race-utils"
import type { FinishContext } from "./types"

export function trackPartyCoClears(ctx: FinishContext): number[] {
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

    const facts = getAwakeBattleProgressFacts(ctx, raceKey)
    if (facts.increments.length > 0) {
        incrementPlayerCategoryMissionsIfSafeSync(ctx.playerId, 9, facts.increments)
    }
    for (const fact of facts.maxima) {
        ensurePlayerCategoryMissionProgressSync(ctx.playerId, 9, fact.missionId, fact.progress)
    }

    return [...new Set([
        ...facts.increments.map(fact => fact.missionId),
        ...facts.maxima.map(fact => fact.missionId),
    ].filter(missionId => Number.isSafeInteger(missionId) && missionId > 0))]
        .sort((left, right) => left - right)
}
