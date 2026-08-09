import { canonicalJsonBuffer, sha256Object } from "../sync/canonical-json"

type ContentDigest = `sha256:${string}`

// Multiplayer compares only data that can affect room eligibility, party
// interpretation, battle entry, or battle settlement. Other server features
// retain coverage through the repository's full contentDigest.
export const MULTI_BATTLE_CONTENT_TABLES = Object.freeze([
    "additional_reward_rules.json",
    "advent_event_quest.json",
    "boss_battle_quest.json",
    "carnival_event_quest.json",
    "carnival_event_total_score_reward.json",
    "challenge_dungeon_event_quest.json",
    "character.json",
    "character_quest.json",
    "clear_reward.json",
    "daily_challenge_point_lookup.json",
    "daily_exp_mana_event_quest.json",
    "daily_week_event_quest.json",
    "event_challenge_point_map.json",
    "ex_quest.json",
    "expert_single_event_quest.json",
    "hard_multi_event_quest.json",
    "main_quest.json",
    "practice_quest.json",
    "quest_entry_costs.json",
    "raid_event.json",
    "raid_event_overall_reward.json",
    "raid_event_quest.json",
    "ranking_event_single_quest.json",
    "rare_score_reward.json",
    "reward_campaign.json",
    "reward_element_map.json",
    "rush_event_quest.json",
    "rush_event_quest_folder.json",
    "rush_event_ranking_reward.json",
    "score_attack_border_reward.json",
    "score_attack_event_quest.json",
    "score_reward.json",
    "solo_time_attack_event_quest.json",
    "stamina_campaign.json",
    "story_event_single_quest.json",
    "tower_dungeon_event_quest.json",
    "world_story_event_boss_battle_quest.json",
    "world_story_event_quest.json",
] as const)

function compareCodePoint(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

function digestIdentities(
    tableDigests: Readonly<Record<string, ContentDigest>>,
): ContentDigest {
    const identities = MULTI_BATTLE_CONTENT_TABLES.map(tableName => {
        const digest = tableDigests[tableName]
        if (digest === undefined) {
            throw new Error(`multiplayer content table is unavailable: ${tableName}`)
        }
        return { tableName, digest }
    }).sort((left, right) => compareCodePoint(left.tableName, right.tableName))
    return sha256Object(canonicalJsonBuffer(identities))
}

export function buildMultiBattleContentDigest(
    tables: Readonly<Record<string, unknown>>,
): ContentDigest {
    return digestIdentities(Object.fromEntries(MULTI_BATTLE_CONTENT_TABLES.map(tableName => {
        if (!Object.prototype.hasOwnProperty.call(tables, tableName)) {
            throw new Error(`multiplayer content table is unavailable: ${tableName}`)
        }
        return [tableName, sha256Object(canonicalJsonBuffer(tables[tableName]))]
    })))
}

export function buildMultiBattleContentDigestFromObjects(
    objectDigests: Readonly<Record<string, ContentDigest>>,
): ContentDigest {
    return digestIdentities(objectDigests)
}
