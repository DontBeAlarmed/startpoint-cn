require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const { randomUUID } = require("node:crypto")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")

// 守护:玩家存档注册表必须覆盖数据库里的每张表。
// 背景:2026-09-28 新增 players_ranking_reward_claims 时漏登记
// PLAYER_SAVE_TABLES,导致存档导出在用户面前报
// "Player save table registry does not match the current database schema"。
// 本测试把该失败提前到 CI:全新初始化的库中,每张表必须落在
// PLAYER_SAVE_TABLES / PLAYER_SAVE_EXCLUDED_TABLES / 基础设施白名单 之一;
// 新增任何表(玩家域或基础设施)都必须有意识地更新对应清单。

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "save-schema-guard-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db
let restoreContentSnapshot = () => {}

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const {
    PLAYER_SAVE_EXCLUDED_TABLES,
    PLAYER_SAVE_TABLES,
} = require("../src/data/player-save/registry")

// 非玩家存档的服务端基础设施表(账号/设备/会话/审计/服务端运营内容/共享状态)。
// 新增基础设施表时在此显式登记;新增玩家域表时必须登记进
// PLAYER_SAVE_TABLES(随存档)或 PLAYER_SAVE_EXCLUDED_TABLES(明确排除)。
const SERVER_INFRASTRUCTURE_TABLES = new Set([
    "account_cleanup_audit",
    "account_cleanup_settings",
    "account_transfer_audit",
    "accounts",
    "device_bindings",
    "raid_event_boss_states",
    "server_gameplay_settings",
    "server_gift_codes",
    "server_gift_rewards",
    "server_news",
    "sessions",
])

initializeDatabase()
db = getDb()

test("every database table is known to the player save registry, excluded list, or infrastructure allowlist", () => {
    const registered = new Set([
        ...PLAYER_SAVE_TABLES.map(definition => definition.name),
        ...PLAYER_SAVE_EXCLUDED_TABLES.map(definition => definition.name),
        ...SERVER_INFRASTRUCTURE_TABLES,
    ])

    const databaseTables = db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
    `).all().map(row => row.name)

    const unknown = databaseTables.filter(name => !registered.has(name))
    assert.deepEqual(
        unknown,
        [],
        "以下表未登记进 PLAYER_SAVE_TABLES / PLAYER_SAVE_EXCLUDED_TABLES / 基础设施白名单:"
        + "新增玩家域表必须随 schema 版本一并登记存档注册表(或显式排除),"
        + "新增服务端基础设施表必须更新本测试的 SERVER_INFRASTRUCTURE_TABLES",
    )

    const phantom = [...registered].filter(name => !databaseTables.includes(name)).sort()
    assert.deepEqual(
        phantom,
        [],
        "注册表/白名单引用了数据库中不存在的表——登记过期,请清理",
    )
})
