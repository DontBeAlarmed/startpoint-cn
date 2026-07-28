import { Database } from "better-sqlite3"
import {
    PlayerSaveDomainName,
    PlayerSaveExcludedTableDefinition,
    PlayerSaveTableDefinition,
} from "./types"

function table(
    name: string,
    domain: PlayerSaveDomainName,
    introducedSchema = 1,
    regenerateColumns?: readonly string[],
    clonePolicy?: "clear",
): PlayerSaveTableDefinition {
    return { name, domain, introducedSchema, regenerateColumns, clonePolicy }
}

export const PLAYER_SAVE_TABLES: readonly PlayerSaveTableDefinition[] = [
    table("players", "core"),
    table("daily_challenge_point_list_entries", "core"),
    table("daily_challenge_point_list_campaigns", "core"),
    table("players_triggered_tutorials", "core"),
    table("players_tutorial_step_receipts", "core", 9, undefined, "clear"),
    table("players_characters", "core"),
    table("players_characters_bond_tokens", "core"),
    table("players_characters_mana_nodes", "core"),
    table("players_character_awake_unlocks", "core", 4),
    table("players_party_groups", "core"),
    table("players_parties", "core"),
    table("players_options", "core"),
    table("players_items", "core"),
    table("players_collected_items", "core", 6),
    table("players_equipment", "core"),
    table("players_quest_progress", "core"),
    table("players_drawn_quests", "core"),

    table("players_cleared_regular_missions", "missions"),
    table("players_active_missions", "missions"),
    table("players_active_missions_stages", "missions"),
    table("players_active_mission_counters", "missions", 8),
    table("players_active_mission_battle_condition_facts", "missions", 8),
    table("players_active_mission_battle_facts", "missions", 8),
    table("players_category_missions", "missions", 3),
    table("players_category_mission_stages", "missions", 3),
    table("players_character_quest_clears", "missions", 3),
    table("players_party_member_co_clears", "missions", 3),
    table("players_party_race_clears", "missions", 3),
    table("players_mission_battle_counters", "missions", 5),
    table("players_degree_battle_stats", "missions", 8),
    table("players_degrees", "missions", 5),
    table("players_periodic_snapshots", "missions", 3),
    table("players_event_mission_login_days", "missions", 8),

    table("players_box_gacha", "events"),
    table("players_box_gacha_drawn_rewards", "events"),
    table("players_start_dash_exchange_campaigns", "events"),
    table("players_multi_special_exchange_campaigns", "events"),
    table("players_rush_events", "events"),
    table("players_rush_events_cleared_folders", "events"),
    table("players_rush_events_played_parties", "events"),
    table("players_raid_events", "events", 8),
    table("players_raid_event_quests", "events", 8),
    table("players_carnival_event_records", "events", 3),
    table("players_carnival_event_rewards", "events", 5),
    table("players_character_election_votes", "events", 10),
    table("players_pass_cards", "events", 7),
    table("players_pass_card_rewards", "events", 7),
    table("players_score_attack_battle_history", "events", 11, ["id"]),
    table("players_practice_battle_history", "events", 13, ["id"]),

    table("players_gacha_info", "economy"),
    table("players_gacha_campaigns", "economy"),
    table("players_periodic_reward_points", "economy"),
    table("players_shop_purchases", "economy", 3),
    table("players_shop_purchase_counters", "economy", 11),
    table("players_shop_campaign_lineups", "economy", 12),
    table("players_receive_history", "economy", 2, ["id"]),

    table("players_mails", "mailbox", 2, ["id"]),
]

export const PLAYER_SAVE_EXCLUDED_TABLES: readonly PlayerSaveExcludedTableDefinition[] = [
    { name: "players_active_quests", reason: "activeQuest" },
]

function quoteIdentifier(identifier: string): string {
    if (!/^[a-z0-9_]+$/.test(identifier)) throw new Error(`Unsafe SQLite identifier: ${identifier}`)
    return `"${identifier}"`
}

function listTableNames(database: Database): string[] {
    return (database.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
    `).all() as Array<{ name: string }>).map(row => row.name)
}

export function discoverPlayerOwnedTablesSync(database: Database): string[] {
    const tableNames = listTableNames(database)
    const metadata = new Map(tableNames.map(name => {
        const identifier = quoteIdentifier(name)
        const columns = database.prepare(`PRAGMA table_info(${identifier})`).all() as Array<{ name: string }>
        const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${identifier})`).all() as Array<{ table: string }>
        return [name, {
            hasPlayerId: columns.some(column => column.name === "player_id"),
            parents: foreignKeys.map(foreignKey => foreignKey.table),
        }] as const
    }))
    const owned = new Set<string>(["players"])
    for (const [name, tableMetadata] of metadata) {
        if (tableMetadata.hasPlayerId || name.startsWith("players_")) owned.add(name)
    }

    let changed = true
    while (changed) {
        changed = false
        for (const [name, tableMetadata] of metadata) {
            if (owned.has(name)) continue
            if (tableMetadata.parents.some(parent => owned.has(parent))) {
                owned.add(name)
                changed = true
            }
        }
    }
    return [...owned].filter(name => metadata.has(name)).sort()
}

export function getPlayerSaveTableDefinition(name: string): PlayerSaveTableDefinition | undefined {
    return PLAYER_SAVE_TABLES.find(tableDefinition => tableDefinition.name === name)
}

export function quotePlayerSaveIdentifier(identifier: string): string {
    return quoteIdentifier(identifier)
}
