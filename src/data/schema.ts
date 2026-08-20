import type { Database } from "better-sqlite3";

const schemaColumns = {
    "players.tutorial_gacha_character_id": {
        table: "players",
        column: "tutorial_gacha_character_id",
        definition: "INTEGER DEFAULT NULL",
    },
    "players.total_stamina_used": {
        table: "players",
        column: "total_stamina_used",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players.total_powerflips": {
        table: "players",
        column: "total_powerflips",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players.total_dashes": {
        table: "players",
        column: "total_dashes",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players.total_mana_obtained": {
        table: "players",
        column: "total_mana_obtained",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players.max_combo_achieved": {
        table: "players",
        column: "max_combo_achieved",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players.total_login_days": {
        table: "players",
        column: "total_login_days",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_character_quest_clears.leader_clear_count": {
        table: "players_character_quest_clears",
        column: "leader_clear_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_character_quest_clears.leader_multi_count": {
        table: "players_character_quest_clears",
        column: "leader_multi_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_character_quest_clears.leader_power_flip_count": {
        table: "players_character_quest_clears",
        column: "leader_power_flip_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_quest_progress.leader_character_id": {
        table: "players_quest_progress",
        column: "leader_character_id",
        definition: "INTEGER",
    },
    "players_quest_progress.multi_clear_count": {
        table: "players_quest_progress",
        column: "multi_clear_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_quest_progress.unlocked": {
        table: "players_quest_progress",
        column: "unlocked",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "device_bindings.name": {
        table: "device_bindings",
        column: "name",
        definition: "TEXT DEFAULT NULL",
    },
    "accounts.admin_note": {
        table: "accounts",
        column: "admin_note",
        definition: "TEXT DEFAULT NULL",
    },
    "accounts.cleanup_policy": {
        table: "accounts",
        column: "cleanup_policy",
        definition: "TEXT NOT NULL DEFAULT 'retain'",
    },
    "accounts.cleanup_due_at": {
        table: "accounts",
        column: "cleanup_due_at",
        definition: "TEXT DEFAULT NULL",
    },
    "accounts.cleanup_state": {
        table: "accounts",
        column: "cleanup_state",
        definition: "TEXT NOT NULL DEFAULT 'active'",
    },
    "accounts.takeover_password_hash": {
        table: "accounts",
        column: "takeover_password_hash",
        definition: "TEXT DEFAULT NULL",
    },
    "accounts.takeover_udid": {
        table: "accounts",
        column: "takeover_udid",
        definition: "TEXT DEFAULT NULL",
    },
    "players_characters_mana_nodes.awake_level": {
        table: "players_characters_mana_nodes",
        column: "awake_level",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_characters.ex_boost_status_id": {
        table: "players_characters",
        column: "ex_boost_status_id",
        definition: "INTEGER",
    },
    "players_characters.ex_boost_ability_id_list": {
        table: "players_characters",
        column: "ex_boost_ability_id_list",
        definition: "TEXT",
    },
    "players_characters.illustration_settings": {
        table: "players_characters",
        column: "illustration_settings",
        definition: "TEXT",
    },
    "players_parties.current_battle_power": {
        table: "players_parties",
        column: "current_battle_power",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_parties.before_battle_power": {
        table: "players_parties",
        column: "before_battle_power",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_periodic_snapshots.single_play_count": {
        table: "players_periodic_snapshots",
        column: "single_play_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_periodic_snapshots.single_clear_count": {
        table: "players_periodic_snapshots",
        column: "single_clear_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_periodic_snapshots.multi_play_count": {
        table: "players_periodic_snapshots",
        column: "multi_play_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_periodic_snapshots.multi_clear_count": {
        table: "players_periodic_snapshots",
        column: "multi_clear_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_periodic_snapshots.multi_host_clear_count": {
        table: "players_periodic_snapshots",
        column: "multi_host_clear_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_periodic_snapshots.multi_guest_clear_count": {
        table: "players_periodic_snapshots",
        column: "multi_guest_clear_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_periodic_snapshots.dash_count": {
        table: "players_periodic_snapshots",
        column: "dash_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_periodic_snapshots.power_flip_count": {
        table: "players_periodic_snapshots",
        column: "power_flip_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_periodic_snapshots.login_days": {
        table: "players_periodic_snapshots",
        column: "login_days",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_mission_battle_counters.single_rank_ss_count": {
        table: "players_mission_battle_counters",
        column: "single_rank_ss_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_mission_battle_counters.challenge_dungeon_clear_count": {
        table: "players_mission_battle_counters",
        column: "challenge_dungeon_clear_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_mission_battle_counters.single_score_max": {
        table: "players_mission_battle_counters",
        column: "single_score_max",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_mission_battle_counters.single_clear_time_min": {
        table: "players_mission_battle_counters",
        column: "single_clear_time_min",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_mission_battle_counters.boss_battle_clear_count": {
        table: "players_mission_battle_counters",
        column: "boss_battle_clear_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_mission_battle_counters.skill_use_count": {
        table: "players_mission_battle_counters",
        column: "skill_use_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_active_mission_counters.total_equipment_equip_count": {
        table: "players_active_mission_counters",
        column: "total_equipment_equip_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_active_mission_counters.total_unison_set_count": {
        table: "players_active_mission_counters",
        column: "total_unison_set_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_active_mission_counters.total_party_character_set_count": {
        table: "players_active_mission_counters",
        column: "total_party_character_set_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_active_mission_counters.total_injected_exp_count": {
        table: "players_active_mission_counters",
        column: "total_injected_exp_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_active_mission_counters.total_gacha_campaign_count": {
        table: "players_active_mission_counters",
        column: "total_gacha_campaign_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    "players_active_mission_counters.practice_quest_challenge_count": {
        table: "players_active_mission_counters",
        column: "practice_quest_challenge_count",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
} as const;

export type SchemaColumnKey = keyof typeof schemaColumns;

export function ensureSchemaColumn(
    database: Database,
    key: SchemaColumnKey,
): boolean {
    if (!Object.prototype.hasOwnProperty.call(schemaColumns, key)) {
        throw new Error("Unknown schema column");
    }
    const schema = schemaColumns[key];
    const columns = database.prepare(`PRAGMA table_info("${schema.table}")`).all() as Array<{
        name: string;
    }>;
    if (columns.some(column => column.name === schema.column)) return false;

    database.prepare(
        `ALTER TABLE "${schema.table}" ADD COLUMN "${schema.column}" ${schema.definition}`,
    ).run();
    return true;
}
