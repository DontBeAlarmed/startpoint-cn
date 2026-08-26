import { Database } from "better-sqlite3";
import { ensureQuestHostFinishedStorageSync } from "../../lib/quest/host-finish-persistence";
import {
    ensureActiveQuestBattleSessionIdStorageSync,
    ensureActiveQuestCoordinatorOriginStorageSync,
    ensureActiveQuestEntryItemCountStorageSync,
} from "../../lib/quest/active-quest-persistence";
import { ensureSchemaColumn } from "../schema";
import { pruneSpecialEventPartyGroupsSync } from "../../lib/party-group-persistence";
import { getRealNow } from "../../runtime/time/game-time";

function getInitialDropMultiplier(): number {
    const configured = process.env.DROP_MULTIPLIER
    if (configured === undefined) return 1
    if (!/^\d+$/.test(configured)) {
        throw new Error("DROP_MULTIPLIER must be an integer between 1 and 10")
    }
    const multiplier = Number(configured)
    if (!Number.isSafeInteger(multiplier) || multiplier < 1 || multiplier > 10) {
        throw new Error("DROP_MULTIPLIER must be an integer between 1 and 10")
    }
    return multiplier
}


export default function init(
    database: Database,
    exists: Boolean
) {
    // initialize the database

    database.prepare(`CREATE TABLE IF NOT EXISTS server_gameplay_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        drop_multiplier INTEGER NOT NULL CHECK (drop_multiplier BETWEEN 1 AND 10),
        updated_at TEXT NOT NULL
    )`).run()
    const gameplaySettingsExist = database.prepare(
        "SELECT 1 FROM server_gameplay_settings WHERE id = 1",
    ).get() !== undefined
    if (!gameplaySettingsExist) {
        database.prepare(`
            INSERT INTO server_gameplay_settings (id, drop_multiplier, updated_at)
            VALUES (1, ?, ?)
        `).run(getInitialDropMultiplier(), getRealNow().toISOString())
    }

    // create players table
    database.prepare(`CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        first_login_time DATE NOT NULL,
        idp_alias TEXT NOT NULL,
        idp_code TEXT NOT NULL,
        idp_id TEXT NOT NULL,
        reg_time DATE NOT NULL,
        last_login_time DATE NOT NULL,
        status TEXT NOT NULL,
        username TEXT UNIQUE,
        password_hash TEXT,
        admin_note TEXT DEFAULT NULL,
        cleanup_policy TEXT NOT NULL DEFAULT 'retain',
        cleanup_due_at DATE DEFAULT NULL,
        cleanup_state TEXT NOT NULL DEFAULT 'active',
        takeover_password_hash TEXT DEFAULT NULL,
        takeover_udid TEXT DEFAULT NULL
    )`).run()

    ensureSchemaColumn(database, "accounts.admin_note")
    ensureSchemaColumn(database, "accounts.cleanup_policy")
    ensureSchemaColumn(database, "accounts.cleanup_due_at")
    ensureSchemaColumn(database, "accounts.cleanup_state")
    ensureSchemaColumn(database, "accounts.takeover_password_hash")
    ensureSchemaColumn(database, "accounts.takeover_udid")

    database.prepare(`CREATE TABLE IF NOT EXISTS account_cleanup_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        default_policy TEXT NOT NULL DEFAULT 'retain',
        timeout_ms INTEGER NOT NULL DEFAULT 259200000,
        updated_at DATE NOT NULL
    )`).run()
    database.prepare(`
        INSERT OR IGNORE INTO account_cleanup_settings (id, default_policy, timeout_ms, updated_at)
        VALUES (1, 'retain', 259200000, ?)
    `).run(getRealNow().toISOString())
    database.prepare(`CREATE TABLE IF NOT EXISTS account_cleanup_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        reason TEXT NOT NULL,
        cleanup_policy TEXT NOT NULL,
        player_count INTEGER NOT NULL,
        deleted_at DATE NOT NULL
    )`).run()
    database.prepare(`CREATE TABLE IF NOT EXISTS account_transfer_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_account_id INTEGER,
        source_viewer_id TEXT,
        target_account_id INTEGER NOT NULL,
        target_viewer_id TEXT NOT NULL,
        source_player_count INTEGER NOT NULL,
        source_deleted INTEGER NOT NULL,
        transferred_at DATE NOT NULL
    )`).run()

    // create zat session table
    database.prepare(`CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY NOT NULL,
        account_id INTEGER NOT NULL,
        expires DATE NOT NULL,
        type INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
    )`).run()

    // create players table
    database.prepare(`CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stamina INTEGER NOT NULL,
        stamina_heal_time INTEGER NOT NULL,
        boost_point INTEGER NOT NULL,
        boss_boost_point INTEGER NOT NULL,
        transition_state INTEGER NOT NULL,
        role INTEGER NOT NULL,
        name TEXT NOT NULL,
        last_login_time DATE NOT NULL,
        comment TEXT NOT NULL,
        vmoney INTEGER NOT NULL,
        free_vmoney INTEGER NOT NULL,
        rank_point INTEGER NOT NULL,
        star_crumb INTEGER NOT NULL,
        bond_token INTEGER NOT NULL,
        exp_pool INTEGER NOT NULL,
        exp_pooled_time INTEGER NOT NULL,
        leader_character_id INTEGER NOT NULL,
        party_slot INTEGER NOT NULL,
        degree_id INTEGER NOT NULL,
        birth INTEGER NOT NULL,
        free_mana INTEGER NOT NULL,
        paid_mana INTEGER NOT NULL,
        enable_auto_3x INTEGER NOT NULL,
        total_stamina_used INTEGER NOT NULL DEFAULT 0,
        total_powerflips INTEGER NOT NULL DEFAULT 0,
        total_dashes INTEGER NOT NULL DEFAULT 0,
        total_mana_obtained INTEGER NOT NULL DEFAULT 0,
        max_combo_achieved INTEGER NOT NULL DEFAULT 0,
        total_login_days INTEGER NOT NULL DEFAULT 0,
        last_daily_challenge_real_business_day TEXT DEFAULT NULL,
        account_id INTEGER NOT NULL,
        tutorial_step INTEGER,
        tutorial_skip_flag INTEGER,
        tutorial_gacha_character_id INTEGER DEFAULT NULL,
        time_offset INTEGER DEFAULT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
    )`).run();

    // migration: add tutorial_gacha_character_id to existing tables
    ensureSchemaColumn(database, "players.tutorial_gacha_character_id")

    // migration: add total_stamina_used for mission progress tracking
    ensureSchemaColumn(database, "players.total_stamina_used")

    // migration: add powerflip/dash counters for mission progress
    ensureSchemaColumn(database, "players.total_powerflips")
    ensureSchemaColumn(database, "players.total_dashes")

    // migration: add total_mana_obtained for mission progress tracking
    ensureSchemaColumn(database, "players.total_mana_obtained")
    // migration: max_combo_achieved was added to CREATE TABLE only — existing DBs need this ALTER
    ensureSchemaColumn(database, "players.max_combo_achieved")

    database.prepare(`CREATE TABLE IF NOT EXISTS players_login_bonus_progress (
        player_id INTEGER NOT NULL,
        group_id TEXT NOT NULL,
        last_granted_index INTEGER NOT NULL CHECK (last_granted_index > 0),
        last_granted_business_day TEXT NOT NULL,
        last_granted_real_business_day TEXT DEFAULT NULL,
        received_at INTEGER NOT NULL CHECK (received_at >= 0),
        shown_at INTEGER DEFAULT NULL CHECK (shown_at IS NULL OR shown_at >= 0),
        PRIMARY KEY (player_id, group_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS scheduled_resource_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'player')),
        player_id INTEGER,
        reward_type TEXT NOT NULL CHECK (reward_type IN ('item', 'free_vmoney')),
        reward_id INTEGER,
        grant_amount INTEGER NOT NULL,
        trigger_threshold INTEGER NOT NULL,
        inventory_cap INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        starts_at_real TEXT,
        ends_at_real TEXT,
        description TEXT,
        created_at_real TEXT NOT NULL,
        updated_at_real TEXT NOT NULL,
        CHECK (
            (scope = 'global' AND player_id IS NULL)
            OR (scope = 'player' AND player_id IS NOT NULL)
        ),
        CHECK (
            (reward_type = 'item' AND reward_id IS NOT NULL)
            OR (reward_type = 'free_vmoney' AND reward_id IS NULL)
        ),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_scheduled_resource_rules_player
        ON scheduled_resource_rules (enabled, scope, player_id, id)
    `).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_scheduled_resource_state (
        player_id INTEGER NOT NULL,
        rule_id INTEGER NOT NULL,
        last_granted_business_day TEXT NOT NULL,
        last_granted_at_real TEXT NOT NULL,
        PRIMARY KEY (player_id, rule_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE,
        FOREIGN KEY (rule_id) REFERENCES scheduled_resource_rules (id) ON DELETE CASCADE
    )`).run()
    ensureSchemaColumn(database, "players_login_bonus_progress.last_granted_real_business_day")

    // Historical saves may contain a negative experience pool from an invalid
    // reward or import. The client renders it as zero, so repair it before any
    // player data is served and keep future writes guarded in the player domain.
    const repairedExpPools = database.prepare(
        "UPDATE players SET exp_pool = 0 WHERE exp_pool < 0",
    ).run()
    if (repairedExpPools.changes > 0) {
        console.warn(`[DB] repaired ${repairedExpPools.changes} negative exp_pool value(s)`)
    }

    database.prepare(`CREATE TABLE IF NOT EXISTS players_character_quest_clears (
        player_id INTEGER NOT NULL,
        character_id INTEGER NOT NULL,
        clear_count INTEGER NOT NULL DEFAULT 0,
        multi_count INTEGER NOT NULL DEFAULT 0,
        leader_clear_count INTEGER NOT NULL DEFAULT 0,
        leader_multi_count INTEGER NOT NULL DEFAULT 0,
        leader_power_flip_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_id, character_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // migration: add leader_clear_count for leader-specific awakening missions
    ensureSchemaColumn(database, "players_character_quest_clears.leader_clear_count")

    // migration: add leader_multi_count for co-op leader tracking
    ensureSchemaColumn(database, "players_character_quest_clears.leader_multi_count")

    // migration: add leader_power_flip_count for per-character powerflip missions
    ensureSchemaColumn(database, "players_character_quest_clears.leader_power_flip_count")

    // migration: add total_login_days for weekly mission tracking
    ensureSchemaColumn(database, "players.total_login_days")
    ensureSchemaColumn(database, "players.last_daily_challenge_real_business_day")

    database.prepare(`CREATE TABLE IF NOT EXISTS players_party_member_co_clears (
        player_id INTEGER NOT NULL,
        char_id_a INTEGER NOT NULL,
        char_id_b INTEGER NOT NULL,
        co_clear_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_id, char_id_a, char_id_b),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_party_race_clears (
        player_id INTEGER NOT NULL,
        race_key TEXT NOT NULL,
        clear_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_id, race_key),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_periodic_snapshots (
        player_id INTEGER NOT NULL,
        period_type TEXT NOT NULL,
        quest_clears INTEGER NOT NULL DEFAULT 0,
        stamina_used INTEGER NOT NULL DEFAULT 0,
        rank_ss INTEGER NOT NULL DEFAULT 0,
        rank_s INTEGER NOT NULL DEFAULT 0,
        rank_a INTEGER NOT NULL DEFAULT 0,
        rank_b INTEGER NOT NULL DEFAULT 0,
        single_play_count INTEGER NOT NULL DEFAULT 0,
        single_clear_count INTEGER NOT NULL DEFAULT 0,
        multi_play_count INTEGER NOT NULL DEFAULT 0,
        multi_clear_count INTEGER NOT NULL DEFAULT 0,
        multi_host_clear_count INTEGER NOT NULL DEFAULT 0,
        multi_guest_clear_count INTEGER NOT NULL DEFAULT 0,
        dash_count INTEGER NOT NULL DEFAULT 0,
        power_flip_count INTEGER NOT NULL DEFAULT 0,
        login_days INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (player_id, period_type),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    ensureSchemaColumn(database, "players_periodic_snapshots.single_play_count")
    ensureSchemaColumn(database, "players_periodic_snapshots.single_clear_count")
    ensureSchemaColumn(database, "players_periodic_snapshots.multi_play_count")
    ensureSchemaColumn(database, "players_periodic_snapshots.multi_clear_count")
    ensureSchemaColumn(database, "players_periodic_snapshots.multi_host_clear_count")
    ensureSchemaColumn(database, "players_periodic_snapshots.multi_guest_clear_count")
    ensureSchemaColumn(database, "players_periodic_snapshots.dash_count")
    ensureSchemaColumn(database, "players_periodic_snapshots.power_flip_count")
    ensureSchemaColumn(database, "players_periodic_snapshots.login_days")

    database.prepare(`CREATE TABLE IF NOT EXISTS players_mission_battle_counters (
        player_id INTEGER PRIMARY KEY,
        single_play_count INTEGER NOT NULL DEFAULT 0,
        single_clear_count INTEGER NOT NULL DEFAULT 0,
        multi_play_count INTEGER NOT NULL DEFAULT 0,
        multi_clear_count INTEGER NOT NULL DEFAULT 0,
        multi_host_clear_count INTEGER NOT NULL DEFAULT 0,
        multi_guest_clear_count INTEGER NOT NULL DEFAULT 0,
        single_rank_ss_count INTEGER NOT NULL DEFAULT 0,
        rank_ss_count INTEGER NOT NULL DEFAULT 0,
        rank_s_count INTEGER NOT NULL DEFAULT 0,
        rank_a_count INTEGER NOT NULL DEFAULT 0,
        rank_b_count INTEGER NOT NULL DEFAULT 0,
        challenge_dungeon_clear_count INTEGER NOT NULL DEFAULT 0,
        single_score_max INTEGER NOT NULL DEFAULT 0,
        single_clear_time_min INTEGER NOT NULL DEFAULT 0,
        boss_battle_clear_count INTEGER NOT NULL DEFAULT 0,
        skill_use_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    ensureSchemaColumn(database, "players_mission_battle_counters.single_rank_ss_count")
    ensureSchemaColumn(database, "players_mission_battle_counters.challenge_dungeon_clear_count")
    ensureSchemaColumn(database, "players_mission_battle_counters.single_score_max")
    ensureSchemaColumn(database, "players_mission_battle_counters.single_clear_time_min")
    ensureSchemaColumn(database, "players_mission_battle_counters.boss_battle_clear_count")
    ensureSchemaColumn(database, "players_mission_battle_counters.skill_use_count")

    database.prepare(`CREATE TABLE IF NOT EXISTS players_degree_battle_stats (
        player_id INTEGER PRIMARY KEY,
        fever_count INTEGER NOT NULL DEFAULT 0,
        fever_ms INTEGER NOT NULL DEFAULT 0,
        debuff_enemy_count INTEGER NOT NULL DEFAULT 0,
        clear_enemy_buff_count INTEGER NOT NULL DEFAULT 0,
        clear_self_debuff_count INTEGER NOT NULL DEFAULT 0,
        buff_party_count INTEGER NOT NULL DEFAULT 0,
        heal_party_count REAL NOT NULL DEFAULT 0,
        emotion_count INTEGER NOT NULL DEFAULT 0,
        enemy_kill_count INTEGER NOT NULL DEFAULT 0,
        weak_point_attack_count INTEGER NOT NULL DEFAULT 0,
        power_flip_lv3_count INTEGER NOT NULL DEFAULT 0,
        coffin_reduced_count INTEGER NOT NULL DEFAULT 0,
        damage_deal_max REAL NOT NULL DEFAULT 0,
        revival_coffin_max INTEGER NOT NULL DEFAULT 0,
        party_power_max INTEGER NOT NULL DEFAULT 0,
        skill_chain_max INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS device_bindings (
        device_id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL,
        last_seen DATE NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
    )`).run();

    // migration: device_bindings.name for admin panel identification
    ensureSchemaColumn(database, "device_bindings.name")

    // Existing deployments used the device name as the only administrator-visible
    // retention marker. Preserve the most recently seen non-empty marker when the
    // account-level cleanup fields are introduced.
    database.prepare(`
        UPDATE accounts
        SET admin_note = (
            SELECT name
            FROM device_bindings
            WHERE device_bindings.account_id = accounts.id
              AND name IS NOT NULL
              AND TRIM(name) <> ''
            ORDER BY last_seen DESC
            LIMIT 1
        )
        WHERE admin_note IS NULL
          AND EXISTS (
              SELECT 1
              FROM device_bindings
              WHERE device_bindings.account_id = accounts.id
                AND name IS NOT NULL
                AND TRIM(name) <> ''
          )
    `).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_options (
        key TEXT NOT NULL,
        value INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (key, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_player_history_settings (
        player_id INTEGER PRIMARY KEY,
        player_history_id INTEGER NOT NULL DEFAULT 1,
        background_card_id INTEGER NOT NULL DEFAULT 1,
        degree_id INTEGER NOT NULL DEFAULT 1,
        character_ids TEXT NOT NULL DEFAULT '[null,null,null]',
        unison_character_ids TEXT NOT NULL DEFAULT '[null,null,null]',
        topic_visibility TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_player_history_milestones (
        player_id INTEGER NOT NULL,
        aggregation_target INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        subject_id INTEGER,
        PRIMARY KEY (player_id, aggregation_target, slot),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_triggered_tutorials (
        id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_tutorial_step_receipts (
        player_id INTEGER PRIMARY KEY,
        completed_step INTEGER NOT NULL,
        skip INTEGER NOT NULL,
        response_data TEXT NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_mails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        reason_id INTEGER NOT NULL DEFAULT 0,
        subject TEXT,
        description TEXT,
        type INTEGER NOT NULL,
        type_id INTEGER,
        number INTEGER NOT NULL DEFAULT 1,
        receive_time TEXT NOT NULL DEFAULT '0000-00-00 00:00:00',
        create_time TEXT NOT NULL,
        reward_period_limited INTEGER NOT NULL DEFAULT 0,
        reward_limit_time TEXT,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE INDEX IF NOT EXISTS idx_players_mails_player_id
        ON players_mails (player_id, id DESC)
    `).run()

    database.prepare(`CREATE INDEX IF NOT EXISTS idx_players_mails_player_unreceived
        ON players_mails (player_id, receive_time, id DESC)
    `).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_receive_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        type INTEGER NOT NULL,
        type_id INTEGER,
        number INTEGER NOT NULL DEFAULT 1,
        reason_id INTEGER NOT NULL DEFAULT 0,
        create_time TEXT NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE INDEX IF NOT EXISTS idx_receive_history_player_created
        ON players_receive_history (player_id, create_time DESC, id DESC)
    `).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_cleared_regular_missions (
        id INTEGER NOT NULL,
        value INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_items (
        id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE INDEX IF NOT EXISTS idx_players_items_player_id
        ON players_items (player_id, id)
    `).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_collected_items (
        player_id INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        total_obtained INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_id, item_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS daily_challenge_point_list_entries (
        id INTEGER NOT NULL,
        point INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS daily_challenge_point_list_campaigns (
        campaign_id INTEGER NOT NULL,
        additional_point INTEGER NOT NULL,
        list_entry_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (player_id, campaign_id, list_entry_id),
        FOREIGN KEY (list_entry_id, player_id) REFERENCES daily_challenge_point_list_entries (id, player_id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_characters (
        id INTEGER NOT NULL,
        entry_count INTEGER NOT NULL,
        evolution_level INTEGER NOT NULL,
        over_limit_step INTEGER NOT NULL,
        protection INTEGER NOT NULL,
        join_time DATE NOT NULL,
        update_time DATE NOT NULL,
        exp INTEGER NOT NULL,
        stack INTEGER NOT NULL,
        mana_board_index INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        ex_boost_status_id INTEGER,
        ex_boost_ability_id_list TEXT,
        illustration_settings TEXT,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE INDEX IF NOT EXISTS idx_players_characters_player_id
        ON players_characters (player_id, id)
    `).run()

    // migration: ex_boost / illustration columns were added to CREATE TABLE only
    ensureSchemaColumn(database, "players_characters.ex_boost_status_id")
    ensureSchemaColumn(database, "players_characters.ex_boost_ability_id_list")
    ensureSchemaColumn(database, "players_characters.illustration_settings")

    database.prepare(`CREATE TABLE IF NOT EXISTS players_ex_boost_pending_draws (
        player_id INTEGER PRIMARY KEY,
        character_id INTEGER NOT NULL,
        status_id INTEGER NOT NULL,
        ability_id_list TEXT NOT NULL,
        FOREIGN KEY (character_id, player_id) REFERENCES players_characters (id, player_id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_characters_bond_tokens (
        mana_board_index INTEGER NOT NULL,
        status INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        character_id INTEGER NOT NULL,
        PRIMARY KEY (mana_board_index, player_id, character_id),
        FOREIGN KEY (character_id, player_id) REFERENCES players_characters (id, player_id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE INDEX IF NOT EXISTS idx_player_bond_tokens_player_character
        ON players_characters_bond_tokens (player_id, character_id, mana_board_index)
    `).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_characters_mana_nodes (
        value INTEGER NOT NULL,
        awake_level INTEGER NOT NULL DEFAULT 0,
        character_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (value, character_id, player_id),
        FOREIGN KEY (character_id, player_id) REFERENCES players_characters (id, player_id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE INDEX IF NOT EXISTS idx_player_mana_nodes_player_character
        ON players_characters_mana_nodes (player_id, character_id, value)
    `).run()

    // migration: add awake_level for character awakening system
    ensureSchemaColumn(database, "players_characters_mana_nodes.awake_level")

    database.prepare(`CREATE TABLE IF NOT EXISTS players_character_awake_unlocks (
        player_id INTEGER NOT NULL,
        character_id INTEGER NOT NULL,
        board_index INTEGER NOT NULL,
        awake_level INTEGER NOT NULL,
        PRIMARY KEY (player_id, character_id, board_index),
        FOREIGN KEY (character_id, player_id) REFERENCES players_characters (id, player_id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_party_groups (
        id INTEGER NOT NULL,
        color_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        PRIMARY KEY (id, player_id, category),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_parties (
        slot INTEGER NOT NULL,
        name TEXT NOT NULL,
        character_id_1 INTEGER,
        character_id_2 INTEGER,
        character_id_3 INTEGER,
        unison_character_1 INTEGER,
        unison_character_2 INTEGER,
        unison_character_3 INTEGER,
        equipment_1 INTEGER,
        equipment_2 INTEGER,
        equipment_3 INTEGER,
        ability_soul_1 INTEGER,
        ability_soul_2 INTEGER,
        ability_soul_3 INTEGER,
        edited INTEGER NOT NULL,
        current_battle_power INTEGER NOT NULL DEFAULT 0,
        before_battle_power INTEGER NOT NULL DEFAULT 0,
        player_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        PRIMARY KEY (slot, player_id, group_id, category),
        FOREIGN KEY (group_id, player_id, category) REFERENCES players_party_groups (id, player_id, category) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // migration: add current_battle_power and before_battle_power to existing tables
    ensureSchemaColumn(database, "players_parties.current_battle_power")
    ensureSchemaColumn(database, "players_parties.before_battle_power")
    pruneSpecialEventPartyGroupsSync(database)

    // database.prepare(`CREATE TABLE IF NOT EXISTS players_party_options (
    //     allow_other_players_to_heal_me INTEGER NOT NULL,
    //     slot INTEGER NOT NULL,
    //     player_id INTEGER NOT NULL,
    //     group_id INTEGER NOT NULL,
    //     category INTEGER NOT NULL,
    //     PRIMARY KEY (slot, player_id, group_id, category),
    //     FOREIGN KEY (slot, player_id, group_id, category) REFERENCES players_parties (slot, player_id, group_id, category) ON DELETE CASCADE,
    //     FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    // )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_equipment (
        id INTEGER NOT NULL,
        level INTEGER NOT NULL,
        enhancement_level INTEGER NOT NULL,
        protection INTEGER NOT NULL,
        stack INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE INDEX IF NOT EXISTS idx_players_equipment_player_id
        ON players_equipment (player_id, id)
    `).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_quest_progress (
        section INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        finished INTEGER NOT NULL,
        unlocked INTEGER NOT NULL DEFAULT 0,
        high_score INTEGER,
        clear_rank INTEGER,
        best_elapsed_time_ms INTEGER,
        leader_character_id INTEGER,
        multi_clear_count INTEGER NOT NULL DEFAULT 0,
        host_finished INTEGER,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (section, quest_id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE INDEX IF NOT EXISTS idx_players_quest_progress_player_section_finished
        ON players_quest_progress (player_id, section, finished)
    `).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_score_attack_battle_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        play_id TEXT NOT NULL,
        ability_soul_id_1 INTEGER,
        ability_soul_id_2 INTEGER,
        ability_soul_id_3 INTEGER,
        category_id INTEGER NOT NULL,
        character_1_total_damage REAL,
        character_2_total_damage REAL,
        character_3_total_damage REAL,
        character_id_1 INTEGER,
        character_id_2 INTEGER,
        character_id_3 INTEGER,
        clear_rank INTEGER,
        create_time TEXT NOT NULL,
        elapsed_time_ms REAL NOT NULL,
        enhancement_level_1 INTEGER,
        enhancement_level_2 INTEGER,
        enhancement_level_3 INTEGER,
        equipment1_id INTEGER,
        equipment2_id INTEGER,
        equipment3_id INTEGER,
        equipment_level_1 INTEGER,
        equipment_level_2 INTEGER,
        equipment_level_3 INTEGER,
        finish_kind INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        score REAL,
        total_damage REAL NOT NULL,
        unison_character_id_1 INTEGER,
        unison_character_id_2 INTEGER,
        unison_character_id_3 INTEGER,
        UNIQUE (player_id, play_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_score_attack_history_player_event_id
        ON players_score_attack_battle_history (player_id, event_id, id DESC)
    `).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_practice_battle_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        play_id TEXT NOT NULL,
        ability_soul_id_1 INTEGER,
        ability_soul_id_2 INTEGER,
        ability_soul_id_3 INTEGER,
        category_id INTEGER NOT NULL,
        character_1_total_damage REAL,
        character_2_total_damage REAL,
        character_3_total_damage REAL,
        character_id_1 INTEGER,
        character_id_2 INTEGER,
        character_id_3 INTEGER,
        clear_rank INTEGER,
        create_time TEXT NOT NULL,
        elapsed_time_ms REAL NOT NULL,
        enhancement_level_1 INTEGER,
        enhancement_level_2 INTEGER,
        enhancement_level_3 INTEGER,
        equipment1_id INTEGER,
        equipment2_id INTEGER,
        equipment3_id INTEGER,
        equipment_level_1 INTEGER,
        equipment_level_2 INTEGER,
        equipment_level_3 INTEGER,
        finish_kind INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        score REAL,
        total_damage REAL NOT NULL,
        unison_character_id_1 INTEGER,
        unison_character_id_2 INTEGER,
        unison_character_id_3 INTEGER,
        UNIQUE (player_id, play_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_practice_history_player_id
        ON players_practice_battle_history (player_id, id DESC)
    `).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_shop_campaign_lineups (
        player_id INTEGER NOT NULL,
        shop_type INTEGER NOT NULL,
        campaign_id INTEGER NOT NULL,
        lineup_id INTEGER NOT NULL,
        selected_at TEXT NOT NULL,
        PRIMARY KEY (player_id, shop_type, campaign_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    // migrations for quest progress columns added after the original schema
    ensureSchemaColumn(database, "players_quest_progress.leader_character_id")
    ensureSchemaColumn(database, "players_quest_progress.multi_clear_count")
    ensureSchemaColumn(database, "players_quest_progress.unlocked")

    ensureQuestHostFinishedStorageSync(database)

    database.prepare(`CREATE TABLE IF NOT EXISTS players_gacha_info (
        gacha_id INTEGER NOT NULL,
        is_daily_first INTEGER NOT NULL,
        is_account_first INTEGER NOT NULL,
        gacha_exchange_point INTEGER,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (gacha_id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_gacha_campaigns (
        gacha_id INTEGER NOT NULL,
        campaign_id INTEGER NOT NULL,
        count INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (gacha_id, campaign_id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_drawn_quests (
        category_id INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        odds_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (category_id, quest_id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_periodic_reward_points (
        id INTEGER NOT NULL,
        point INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_active_missions (
        id INTEGER NOT NULL,
        progress INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_active_missions_stages (
        id INTEGER NOT NULL,
        status INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        mission_id INTEGER NOT NULL,
        PRIMARY KEY (id, mission_id, player_id),
        FOREIGN KEY (mission_id, player_id) REFERENCES players_active_missions (id, player_id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_active_mission_counters (
        player_id INTEGER PRIMARY KEY,
        total_used_mana_count INTEGER NOT NULL DEFAULT 0,
        total_gacha_character_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()
    ensureSchemaColumn(database, "players_active_mission_counters.total_equipment_equip_count")
    ensureSchemaColumn(database, "players_active_mission_counters.total_unison_set_count")
    ensureSchemaColumn(database, "players_active_mission_counters.total_party_character_set_count")
    ensureSchemaColumn(database, "players_active_mission_counters.total_injected_exp_count")
    ensureSchemaColumn(database, "players_active_mission_counters.total_gacha_campaign_count")
    ensureSchemaColumn(database, "players_active_mission_counters.practice_quest_challenge_count")

    database.prepare(`CREATE TABLE IF NOT EXISTS players_active_mission_battle_condition_facts (
        player_id INTEGER NOT NULL,
        pattern INTEGER NOT NULL,
        character_id INTEGER NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_id, pattern, character_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_active_mission_battle_facts (
        player_id INTEGER NOT NULL,
        mission_id INTEGER NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_id, mission_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_category_missions (
        category INTEGER NOT NULL,
        id INTEGER NOT NULL,
        progress INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (category, id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE INDEX IF NOT EXISTS idx_category_missions_player_category
        ON players_category_missions (player_id, category, id)
    `).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_category_mission_stages (
        category INTEGER NOT NULL,
        id INTEGER NOT NULL,
        status INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        mission_id INTEGER NOT NULL,
        PRIMARY KEY (category, id, mission_id, player_id),
        FOREIGN KEY (category, mission_id, player_id)
            REFERENCES players_category_missions (category, id, player_id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_event_mission_login_days (
        player_id INTEGER NOT NULL,
        mission_id INTEGER NOT NULL,
        last_counted_day INTEGER NOT NULL,
        PRIMARY KEY (player_id, mission_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_character_election_votes (
        player_id INTEGER NOT NULL,
        election_id INTEGER NOT NULL,
        keyword_id INTEGER NOT NULL,
        voted_at INTEGER NOT NULL,
        PRIMARY KEY (player_id, election_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_pass_cards (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        point INTEGER NOT NULL DEFAULT 0,
        is_buy INTEGER NOT NULL DEFAULT 0,
        login_baseline INTEGER,
        PRIMARY KEY (player_id, event_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_pass_card_rewards (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        reward_id INTEGER NOT NULL,
        is_received_1 INTEGER NOT NULL DEFAULT 0,
        is_received_2 INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_id, event_id, reward_id),
        FOREIGN KEY (player_id, event_id)
            REFERENCES players_pass_cards (player_id, event_id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_box_gacha (
        id INTEGER NOT NULL,
        box_id INTEGER NOT NULL,
        reset_times INTEGER NOT NULL,
        remaining_number INTEGER NOT NULL,
        is_closed INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, box_id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_box_gacha_drawn_rewards (
        id INTEGER NOT NULL,
        box_id INTEGER NOT NULL,
        gacha_id INTEGER NOT NULL,
        number INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, box_id, gacha_id, player_id),
        FOREIGN KEY (gacha_id, box_id, player_id) REFERENCES players_box_gacha (id, box_id, player_id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_start_dash_exchange_campaigns (
        campaign_id INTEGER NOT NULL,
        gacha_id INTEGER NOT NULL,
        term_index INTEGER NOT NULL,
        status INTEGER NOT NULL,
        period_start_time DATE NOT NULL,
        period_end_time DATE NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (campaign_id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_multi_special_exchange_campaigns (
        campaign_id INTEGER NOT NULL,
        status INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (campaign_id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_rush_events (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        active_rush_battle_folder_id INTEGER,
        endless_battle_max_round INTEGER,
        endless_battle_max_round_time INTEGER,
        endless_battle_max_round_character_id_1 INTEGER,
        endless_battle_max_round_character_id_2 INTEGER,
        endless_battle_max_round_character_id_3 INTEGER,
        endless_battle_max_round_character_evolution_img_lvl_1 INTEGER,
        endless_battle_max_round_character_evolution_img_lvl_2 INTEGER,
        endless_battle_max_round_character_evolution_img_lvl_3 INTEGER,
        PRIMARY KEY (player_id, event_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_rush_events_cleared_folders (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        folder_id INTEGER NOT NULL,
        PRIMARY KEY (player_id, event_id, folder_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_rush_events_played_parties (
        character_id_1 INTEGER,
        character_id_2 INTEGER,
        character_id_3 INTEGER,
        unison_character_id_1 INTEGER,
        unison_character_id_2 INTEGER,
        unison_character_id_3 INTEGER,
        equipment_id_1 INTEGER,
        equipment_id_2 INTEGER,
        equipment_id_3 INTEGER,
        ability_soul_id_1 INTEGER,
        ability_soul_id_2 INTEGER,
        ability_soul_id_3 INTEGER,
        evolution_img_level_1 INTEGER,
        evolution_img_level_2 INTEGER,
        evolution_img_level_3 INTEGER,
        unison_evolution_img_level_1 INTEGER,
        unison_evolution_img_level_2 INTEGER,
        unison_evolution_img_level_3 INTEGER,
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        round INTEGER NOT NULL,
        battle_type INTEGER NOT NULL,
        PRIMARY KEY (player_id, event_id, round, battle_type),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_raid_events (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        total_kill_count INTEGER NOT NULL DEFAULT 0,
        received_up_to INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_id, event_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    const hadRaidEventBossStates = database.prepare(`
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name = 'raid_event_boss_states'
    `).get() !== undefined

    database.prepare(`CREATE TABLE IF NOT EXISTS raid_event_boss_states (
        event_id INTEGER PRIMARY KEY,
        weighted_kill_count INTEGER NOT NULL DEFAULT 0,
        total_kill_count INTEGER NOT NULL DEFAULT 0
    )`).run()

    if (!hadRaidEventBossStates) {
        // Old builds stored cumulative quest weight in these fields. It cannot
        // be converted into a shared Boss total without fabricating progress.
        database.prepare(`
            UPDATE players_raid_events
            SET total_kill_count = 0, received_up_to = 0
        `).run()
    }

    database.prepare(`CREATE TABLE IF NOT EXISTS players_raid_event_quests (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        kill_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_id, event_id, quest_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_carnival_event_records (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        folder_id INTEGER NOT NULL,
        best_score INTEGER,
        previous_score INTEGER,
        previous_character_ids TEXT,
        previous_unison_character_ids TEXT,
        PRIMARY KEY (player_id, event_id, folder_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_carnival_event_rewards (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        reward_id INTEGER NOT NULL,
        PRIMARY KEY (player_id, event_id, reward_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_degrees (
        player_id INTEGER NOT NULL,
        degree_id INTEGER NOT NULL,
        PRIMARY KEY (player_id, degree_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_shop_purchases (
        player_id INTEGER NOT NULL,
        shop_item_id INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_id, shop_item_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_shop_purchase_counters (
        player_id INTEGER NOT NULL,
        shop_type INTEGER NOT NULL,
        shop_item_id INTEGER NOT NULL,
        period_type TEXT NOT NULL,
        period_key TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_id, shop_type, shop_item_id, period_type, period_key),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()
    database.prepare(`
        INSERT OR IGNORE INTO players_shop_purchase_counters (
            player_id, shop_type, shop_item_id, period_type, period_key, count
        )
        SELECT player_id, -1, shop_item_id, 'total', '', count
        FROM players_shop_purchases
    `).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_active_quests (
        player_id INTEGER PRIMARY KEY,
        play_id TEXT NOT NULL,
        quest_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        use_boss_boost_point INTEGER NOT NULL DEFAULT 0,
        use_boost_point INTEGER NOT NULL DEFAULT 0,
        is_auto_start_mode INTEGER NOT NULL DEFAULT 0,
        is_multi INTEGER NOT NULL DEFAULT 0,
        coordinator_origin TEXT CHECK (
            coordinator_origin IS NULL OR coordinator_origin IN ('remote', 'local')
        ),
        room_number TEXT,
        battle_session_id TEXT,
        entry_item_id INTEGER,
        entry_item_count INTEGER,
        event_id INTEGER,
        continue_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()
    ensureActiveQuestEntryItemCountStorageSync(database)
    ensureActiveQuestBattleSessionIdStorageSync(database)
    ensureActiveQuestCoordinatorOriginStorageSync(database)
}
