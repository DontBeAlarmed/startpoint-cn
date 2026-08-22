"use strict"

const { isDeepStrictEqual } = require("node:util")

const API_PREFIX = "/api/index.php/multi_battle_quest"
const DEFAULT_TASK_TIMEOUT_MS = 5_000
const LIMITED_ERROR = Symbol("limitedError")
const metadataByDataKey = new Map()
const auditByDataKey = new Map()
const EXCLUDED_TABLES = new Set([
    "migrations",
    "schema_migrations",
    "sessions",
])
const LEGACY_PLAYER_FIELDS = Object.freeze([
    ["stamina", "stamina"],
    ["boost_point", "boostPoint"],
    ["boss_boost_point", "bossBoostPoint"],
    ["vmoney", "vmoney"],
    ["free_vmoney", "freeVmoney"],
    ["free_mana", "freeMana"],
    ["paid_mana", "paidMana"],
    ["rank_point", "rankPoint"],
    ["star_crumb", "starCrumb"],
    ["bond_token", "bondToken"],
    ["exp_pool", "expPool"],
    ["degree_id", "degreeId"],
    ["total_stamina_used", "totalStaminaUsed"],
    ["total_powerflips", "totalPowerflips"],
    ["total_dashes", "totalDashes"],
    ["total_mana_obtained", "totalManaObtained"],
    ["max_combo_achieved", "maxComboAchieved"],
])

function limitedError(message, ErrorType = Error) {
    const error = new ErrorType(message)
    Object.defineProperty(error, LIMITED_ERROR, { value: true })
    return error
}

function stageError(stage, outcome = "failed", ErrorType = Error) {
    return limitedError(`${stage} ${outcome}`, ErrorType)
}

function validateTimeout(timeoutMs, stage) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw stageError(`${stage} timeout validation`, "failed", TypeError)
    }
}

async function runTaskWithinTimeout(task, stage, timeoutMs) {
    validateTimeout(timeoutMs, stage)
    let timer
    const observed = Promise.resolve().then(task).then(
        value => ({ status: "fulfilled", value }),
        () => ({ status: "rejected" }),
    )
    const timedOut = new Promise(resolve => {
        timer = setTimeout(() => resolve({ status: "timedOut" }), timeoutMs)
    })
    const result = await Promise.race([observed, timedOut])
    clearTimeout(timer)
    if (result.status === "fulfilled") return result.value
    if (result.status === "rejected") throw stageError(stage)
    throw stageError(stage, "timed out")
}

function quoteIdentifier(value) {
    return `"${String(value).replaceAll('"', '""')}"`
}

function stableValue(value) {
    if (Buffer.isBuffer(value)) {
        return { type: "blob", base64: value.toString("base64") }
    }
    if (typeof value === "bigint") return { type: "integer", decimal: value.toString() }
    return value
}

function inspectOwnershipMetadata(database) {
    const tableNames = database.prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
    `).all().map(row => row.name)
    const ownedTables = []
    for (const tableName of tableNames) {
        if (EXCLUDED_TABLES.has(tableName)) continue
        const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all()
        const columnNames = columns.map(column => column.name)
        const ownerColumn = tableName === "players" && columnNames.includes("id")
            ? "id"
            : columnNames.includes("player_id") ? "player_id" : null
        if (ownerColumn === null) continue
        const primaryKey = columns
            .filter(column => column.pk > 0)
            .sort((left, right) => left.pk - right.pk)
            .map(column => column.name)
        ownedTables.push(Object.freeze({
            name: tableName,
            ownerColumn,
            columns: Object.freeze(columnNames),
            orderBy: Object.freeze(primaryKey.length > 0 ? primaryKey : columnNames),
        }))
    }
    return Object.freeze({
        tables: Object.freeze(ownedTables),
        introspectionQueries: 1 + tableNames.filter(name => !EXCLUDED_TABLES.has(name)).length,
    })
}

function metadataFor(database, dataKey) {
    let metadata = metadataByDataKey.get(dataKey)
    if (!metadata) {
        metadata = inspectOwnershipMetadata(database)
        metadataByDataKey.set(dataKey, metadata)
    }
    return metadata
}

function readOwnedTable(database, table, playerId) {
    const columns = table.columns.map(quoteIdentifier).join(", ")
    const orderBy = table.orderBy.length === 0
        ? ""
        : ` ORDER BY ${table.orderBy.map(quoteIdentifier).join(", ")}`
    const rows = database.prepare(
        `SELECT ${columns} FROM ${quoteIdentifier(table.name)}`
        + ` WHERE ${quoteIdentifier(table.ownerColumn)} = ?${orderBy}`,
    ).all(playerId)
    return rows.map(row => Object.fromEntries(
        table.columns.map(column => [column, stableValue(row[column])]),
    ))
}

function legacyPlayer(ownershipTables) {
    const row = ownershipTables.players?.[0] ?? null
    if (row === null) return null
    return Object.fromEntries(LEGACY_PLAYER_FIELDS.flatMap(([column, property]) => (
        Object.hasOwn(row, column) ? [[property, row[column]]] : []
    )))
}

function snapshotSettlementState(harness, node) {
    return harness.withDatabase(node.dataKey, database => {
        const metadata = metadataFor(database, node.dataKey)
        const ownershipTables = Object.fromEntries(metadata.tables.map(table => [
            table.name,
            readOwnedTable(database, table, node.playerId),
        ]))
        auditByDataKey.set(node.dataKey, Object.freeze({
            dataKey: node.dataKey,
            dynamicColumnsExcluded: Object.freeze([]),
            introspectionQueries: metadata.introspectionQueries,
            snapshotQueries: metadata.tables.length,
            tables: Object.freeze(metadata.tables.map(table => Object.freeze({
                name: table.name,
                ownerColumn: table.ownerColumn,
                columns: table.columns,
                orderBy: table.orderBy,
            }))),
        }))
        return {
            player: legacyPlayer(ownershipTables),
            activeQuests: ownershipTables.players_active_quests ?? [],
            ownershipTables,
        }
    }, { readonly: true })
}

function settlementSnapshotAudit(dataKey) {
    return auditByDataKey.get(dataKey) ?? null
}

function buildFinishPayload(node, roomNumber, quest, playId) {
    return {
        viewer_id: node.viewerId,
        api_count: 1,
        quest_id: quest.questId,
        category: quest.category,
        room_number: roomNumber,
        play_id: playId,
        score: 0,
        elapsed_time_ms: 1_000,
        add_mana: 0,
        is_accomplished: true,
        continue_count: 0,
        statistics: {
            clear_phase: 1,
            max_combo_count: 0,
            zones: [{ use_power_flip_count: 1 }],
            party: {
                characters: [{ id: 1 }, null, null],
                unison_characters: [null, null, null],
                equipments: [null, null, null],
                ability_soul_ids: [null, null, null],
            },
        },
        mate_player_result: [],
    }
}

function isSuccessfulFinish(response) {
    return response?.status === 200
        && response.body?.data_headers?.result_code === 1
}

async function finishPlayer(harness, node, {
    roomNumber,
    quest,
    playId,
    timeoutMs = DEFAULT_TASK_TIMEOUT_MS,
}) {
    validateTimeout(timeoutMs, "finish")
    const payload = buildFinishPayload(node, roomNumber, quest, playId)
    const first = await runTaskWithinTimeout(
        () => harness.gamePost(node.url, `${API_PREFIX}/finish`, payload),
        "finish request",
        timeoutMs,
    )
    if (!isSuccessfulFinish(first)) throw stageError("finish response")
    let settledState
    try {
        settledState = snapshotSettlementState(harness, node)
    } catch {
        throw stageError("finish state")
    }
    const duplicate = await runTaskWithinTimeout(
        () => harness.gamePost(node.url, `${API_PREFIX}/finish`, payload),
        "duplicate finish request",
        timeoutMs,
    )
    let duplicateState
    try {
        duplicateState = snapshotSettlementState(harness, node)
    } catch {
        throw stageError("duplicate finish state")
    }
    if (!isDeepStrictEqual(duplicateState, settledState)) {
        throw stageError("duplicate finish state")
    }
    if (isSuccessfulFinish(duplicate)) throw stageError("duplicate finish response")
    return settledState
}

module.exports = {
    buildFinishPayload,
    finishPlayer,
    settlementSnapshotAudit,
    snapshotSettlementState,
}
