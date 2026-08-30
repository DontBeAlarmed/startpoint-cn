import { Database } from "better-sqlite3"
import { BUNDLED_CDN_CATALOG_VERSION } from "../../content/constants"
import { getEffectiveVersion } from "../../lib/version"
import { clearPublishedActiveQuest } from "../../lib/quest/active-quest-service"
import { loadCurrentBundleMetadata } from "../../runtime/bundle-metadata"
import { getDb } from "../db"
import { insertDefaultPlayerSync, replacePlayerDataSync } from "../domains/player"
import {
    clearGiftRedemptionsForExternalRestoreSync,
    copyGiftRedemptionsForCloneSync,
} from "../domains/gift"
import { getRealNow, getRealNowMs } from "../../runtime/time/game-time"
import { normalizeImportedExpPoolAnchor } from "../../lib/exp-pool-time"
import { reviveMergedPlayerDates } from "../utils/date"
import {
    PLAYER_SAVE_EXCLUDED_TABLES,
    PLAYER_SAVE_TABLES,
    inspectPlayerSaveSchemaSync,
    quotePlayerSaveIdentifier,
    type PlayerSaveTableMetadata,
} from "./registry"
import {
    PLAYER_SAVE_FORMAT_VERSION,
    PLAYER_SAVE_SCHEMA,
    ParsedPlayerSaveSnapshot,
    PlayerSaveDomainName,
    PlayerSaveDomainSnapshot,
    PlayerSaveRestoreResult,
    PlayerSaveRow,
    PlayerSaveTableDefinition,
    PlayerSaveV2Snapshot,
} from "./types"

const DOMAIN_NAMES: readonly PlayerSaveDomainName[] = ["core", "missions", "events", "economy", "mailbox"]
const EXCLUDED_DOMAINS = ["account", "session", "serverConfig", "activeQuest"] as const
const LEGACY_V1_UNMANAGED_TABLES = new Set([
    "players_tutorial_step_receipts",
    "players_box_gacha",
    "players_box_gacha_drawn_rewards",
    "players_collected_items",
    "players_character_quest_clears",
    "players_party_member_co_clears",
    "players_party_race_clears",
    "players_active_mission_counters",
    "players_active_mission_battle_condition_facts",
    "players_active_mission_battle_facts",
    "players_mission_battle_counters",
    "players_degree_battle_stats",
    "players_periodic_snapshots",
    "players_event_mission_login_days",
    "players_character_election_votes",
    "players_pass_cards",
    "players_pass_card_rewards",
    "players_login_bonus_progress",
    "players_raid_events",
    "players_raid_event_quests",
    "players_score_attack_battle_history",
    "players_practice_battle_history",
    "players_shop_purchases",
    "players_shop_purchase_counters",
    "players_shop_campaign_lineups",
    "players_receive_history",
    "players_mails",
])

export {
    clearGiftRedemptionsForExternalRestoreSync,
    copyGiftRedemptionsForCloneSync,
}

interface SqliteColumn {
    name: string
    type: string
    notnull: 0 | 1
    dflt_value: unknown
    pk: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requireSafePositiveInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new Error(`${label} must be a positive safe integer`)
    }
    return value as number
}

function assertCanonicalSaveDatabase(database: Database): void {
    if (database !== getDb()) {
        throw new Error("Player save mutations require the canonical database connection")
    }
}

function getCurrentSchemaVersion(database: Database): number {
    const version = database.pragma("user_version", { simple: true })
    if (!Number.isSafeInteger(version) || (version as number) < 0) {
        throw new Error("SQLite returned an invalid schema version")
    }
    return version as number
}

function getSnapshotContentVersion(): string {
    try {
        return getEffectiveVersion()
    } catch {
        return BUNDLED_CDN_CATALOG_VERSION
    }
}

function getTableColumns(database: Database, tableName: string): SqliteColumn[] {
    return database.prepare(
        `PRAGMA table_info(${quotePlayerSaveIdentifier(tableName)})`,
    ).all() as SqliteColumn[]
}

function getMetadataColumns(
    database: Database,
    tableName: string,
    metadata?: ReadonlyMap<string, PlayerSaveTableMetadata>,
): SqliteColumn[] {
    const cachedColumns = metadata?.get(tableName)?.columns
    if (cachedColumns !== undefined) return cachedColumns as SqliteColumn[]
    return getTableColumns(database, tableName)
}

function getPrimaryKeyOrder(
    database: Database,
    tableName: string,
    metadata?: ReadonlyMap<string, PlayerSaveTableMetadata>,
): string[] {
    const cachedColumns = metadata?.get(tableName)?.columns
    if (cachedColumns !== undefined) {
        return cachedColumns
            .filter(column => column.pk > 0)
            .sort((left, right) => left.pk - right.pk)
            .map(column => column.name)
    }
    return getMetadataColumns(database, tableName, metadata)
        .filter(column => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map(column => column.name)
}

function createEmptyDomains(): Record<PlayerSaveDomainName, PlayerSaveDomainSnapshot> {
    return {
        core: { version: 1, tables: {} },
        missions: { version: 1, tables: {} },
        events: { version: 1, tables: {} },
        economy: { version: 1, tables: {} },
        mailbox: { version: 1, tables: {} },
    }
}

function assertRegistryMatchesDatabase(database: Database): ReadonlyMap<string, PlayerSaveTableMetadata> {
    const inspection = inspectPlayerSaveSchemaSync(database)
    const discovered = inspection.ownedTables
    const classified = [
        ...PLAYER_SAVE_TABLES.map(definition => definition.name),
        ...PLAYER_SAVE_EXCLUDED_TABLES.map(definition => definition.name),
    ].sort()
    if (new Set(classified).size !== classified.length || discovered.join("\n") !== classified.join("\n")) {
        throw new Error("Player save table registry does not match the current database schema")
    }
    return inspection.metadata
}

function selectPlayerRows(
    database: Database,
    definition: PlayerSaveTableDefinition,
    playerId: number,
    metadata?: ReadonlyMap<string, PlayerSaveTableMetadata>,
): PlayerSaveRow[] {
    const identifier = quotePlayerSaveIdentifier(definition.name)
    const predicate = definition.name === "players" ? "id = ?" : "player_id = ?"
    const primaryKey = getPrimaryKeyOrder(database, definition.name, metadata)
    const orderBy = primaryKey.length > 0
        ? ` ORDER BY ${primaryKey.map(quotePlayerSaveIdentifier).join(", ")}`
        : ""
    return database.prepare(
        `SELECT * FROM ${identifier} WHERE ${predicate}${orderBy}`,
    ).all(playerId) as PlayerSaveRow[]
}

export function exportPlayerSaveV2Sync(
    playerId: number,
    database: Database = getDb(),
): PlayerSaveV2Snapshot {
    requireSafePositiveInteger(playerId, "playerId")
    const schemaMetadata = assertRegistryMatchesDatabase(database)

    const domains = createEmptyDomains()
    for (const definition of PLAYER_SAVE_TABLES) {
        domains[definition.domain].tables[definition.name] = selectPlayerRows(
            database,
            definition,
            playerId,
            schemaMetadata,
        )
    }
    if (domains.core.tables.players.length !== 1) throw new Error(`Player ${playerId} was not found`)

    return {
        schema: PLAYER_SAVE_SCHEMA,
        version: PLAYER_SAVE_FORMAT_VERSION,
        formatVersion: PLAYER_SAVE_FORMAT_VERSION,
        mode: "backup",
        exportedAt: getRealNow().toISOString(),
        playerId,
        producer: {
            serverVersion: loadCurrentBundleMetadata().version,
            dbSchemaVersion: getCurrentSchemaVersion(database),
            contentVersion: getSnapshotContentVersion(),
        },
        domains,
        excludedDomains: [...EXCLUDED_DOMAINS],
    }
}

export function parsePlayerSaveSnapshot(input: unknown): ParsedPlayerSaveSnapshot {
    if (!isPlainObject(input) || input.schema !== PLAYER_SAVE_SCHEMA) {
        throw new Error("Invalid player save schema")
    }
    if (
        input.formatVersion !== undefined
        && input.version !== undefined
        && input.formatVersion !== input.version
    ) {
        throw new Error("Player save version fields conflict")
    }
    const version = input.formatVersion ?? input.version
    if (version === 1) {
        if (!isPlainObject(input.data) || !isPlainObject(input.data.player)) {
            throw new Error("Legacy v1 save is missing data.player")
        }
        return {
            kind: "legacy-v1",
            legacyPartial: true,
            snapshot: input as any,
        }
    }
    if (version !== PLAYER_SAVE_FORMAT_VERSION) {
        throw new Error(`Unsupported player save format version: ${String(version)}`)
    }
    return {
        kind: "v2",
        legacyPartial: false,
        snapshot: input as unknown as PlayerSaveV2Snapshot,
    }
}

function flattenAndValidateV2Snapshot(
    snapshot: PlayerSaveV2Snapshot,
    database: Database,
    metadata: ReadonlyMap<string, PlayerSaveTableMetadata>,
): Map<string, PlayerSaveRow[]> {
    const currentSchema = getCurrentSchemaVersion(database)
    if (!isPlainObject(snapshot.producer)) throw new Error("Player save producer metadata is missing")
    const producerSchema = snapshot.producer.dbSchemaVersion
    if (!Number.isSafeInteger(producerSchema) || producerSchema < 1) {
        throw new Error("Player save producer schema is invalid")
    }
    if (producerSchema > currentSchema) {
        throw new Error(`Cannot restore a newer database schema ${producerSchema} into schema ${currentSchema}`)
    }
    const sourcePlayerId = requireSafePositiveInteger(snapshot.playerId, "snapshot.playerId")
    if (!isPlainObject(snapshot.domains)) throw new Error("Player save domains are missing")
    if (snapshot.mode !== "backup") throw new Error("Player save mode is invalid")
    for (const domainName of Object.keys(snapshot.domains)) {
        if (!DOMAIN_NAMES.includes(domainName as PlayerSaveDomainName)) {
            throw new Error(`Unknown player save domain: ${domainName}`)
        }
    }
    if (
        !Array.isArray(snapshot.excludedDomains)
        || snapshot.excludedDomains.join("\n") !== EXCLUDED_DOMAINS.join("\n")
    ) {
        throw new Error("Player save excluded domains are invalid")
    }
    if (
        typeof snapshot.producer.serverVersion !== "string"
        || typeof snapshot.producer.contentVersion !== "string"
    ) {
        throw new Error("Player save producer versions are invalid")
    }

    const registeredByName = new Map(PLAYER_SAVE_TABLES.map(definition => [definition.name, definition]))
    const tables = new Map<string, PlayerSaveRow[]>()
    for (const domainName of DOMAIN_NAMES) {
        const domain = snapshot.domains[domainName]
        if (!isPlainObject(domain) || domain.version !== 1 || !isPlainObject(domain.tables)) {
            throw new Error(`Player save domain ${domainName} is missing or invalid`)
        }
        for (const [tableName, rows] of Object.entries(domain.tables)) {
            const definition = registeredByName.get(tableName)
            if (definition === undefined) throw new Error(`Unknown player save table: ${tableName}`)
            if (definition.domain !== domainName) {
                throw new Error(`Player save table ${tableName} is in the wrong domain`)
            }
            if (tables.has(tableName)) throw new Error(`Duplicate player save table: ${tableName}`)
            if (!Array.isArray(rows)) throw new Error(`Player save table ${tableName} rows must be an array`)

            const tableColumns = getMetadataColumns(database, tableName, metadata)
            const columns = new Set(tableColumns.map(column => column.name))
            const regenerated = new Set(definition.regenerateColumns ?? [])
            for (const [rowIndex, row] of rows.entries()) {
                if (!isPlainObject(row)) throw new Error(`Player save table ${tableName} row ${rowIndex} is invalid`)
                for (const [columnName, value] of Object.entries(row)) {
                    if (!columns.has(columnName)) {
                        throw new Error(`Player save table ${tableName} has unknown column ${columnName}`)
                    }
                    if (
                        value !== null
                        && typeof value !== "string"
                        && typeof value !== "number"
                    ) {
                        throw new Error(`Player save table ${tableName}.${columnName} has an invalid value`)
                    }
                    if (typeof value === "number" && !Number.isFinite(value)) {
                        throw new Error(`Player save table ${tableName}.${columnName} has an invalid number`)
                    }
                }
                for (const column of tableColumns) {
                    if (
                        column.notnull === 1
                        && column.dflt_value === null
                        && !regenerated.has(column.name)
                        && !Object.prototype.hasOwnProperty.call(row, column.name)
                    ) {
                        throw new Error(`Player save table ${tableName}.${column.name} is missing`)
                    }
                }
                if (tableName !== "players" && row.player_id !== sourcePlayerId) {
                    throw new Error(`Player save table ${tableName} contains a foreign player_id`)
                }
            }
            tables.set(tableName, rows)
        }
    }

    for (const definition of PLAYER_SAVE_TABLES) {
        if (!tables.has(definition.name)) {
            if (producerSchema >= definition.introducedSchema) {
                throw new Error(`Player save table ${definition.name} is missing`)
            }
            tables.set(definition.name, [])
        }
    }

    const players = tables.get("players")!
    if (players.length !== 1 || players[0].id !== sourcePlayerId) {
        throw new Error("Player save must contain exactly one matching players row")
    }
    return tables
}

function getInsertionOrder(
    metadata: ReadonlyMap<string, PlayerSaveTableMetadata>,
): PlayerSaveTableDefinition[] {
    const childDefinitions = PLAYER_SAVE_TABLES.filter(definition => definition.name !== "players")
    const pending = new Map(childDefinitions.map(definition => [definition.name, definition]))
    const inserted = new Set<string>(["players"])
    const result: PlayerSaveTableDefinition[] = []

    while (pending.size > 0) {
        let progressed = false
        for (const [tableName, definition] of pending) {
            const dependencies = (metadata.get(tableName)?.parents ?? [])
                .filter(parent => pending.has(parent) || inserted.has(parent))
            if (dependencies.every(parent => inserted.has(parent))) {
                result.push(definition)
                inserted.add(tableName)
                pending.delete(tableName)
                progressed = true
            }
        }
        if (!progressed) {
            throw new Error(`Player save registry contains an unresolved foreign-key cycle: ${[...pending.keys()].join(", ")}`)
        }
    }
    return result
}

function updatePlayerRoot(
    database: Database,
    sourceRow: PlayerSaveRow,
    targetPlayerId: number,
    metadata: ReadonlyMap<string, PlayerSaveTableMetadata>,
): void {
    const currentColumns = getMetadataColumns(database, "players", metadata).map(column => column.name)
    const columns = currentColumns.filter(column => column !== "id" && column !== "account_id")
    const availableColumns = columns.filter(
        column => Object.prototype.hasOwnProperty.call(sourceRow, column) || column === "time_offset",
    )
    if (availableColumns.length === 0) throw new Error("Player save root row has no restorable columns")
    const values = availableColumns.map(column => {
        if (column === "time_offset") return null
        if (column === "exp_pooled_time") {
            return normalizeImportedExpPoolAnchor(
                new Date(sourceRow[column] as string),
                getRealNow(),
            ).toISOString()
        }
        return sourceRow[column]
    })
    const assignments = availableColumns.map(column => `${quotePlayerSaveIdentifier(column)} = ?`).join(", ")
    database.prepare(`UPDATE players SET ${assignments} WHERE id = ?`).run(...values, targetPlayerId)
}

function insertSnapshotRows(
    database: Database,
    definition: PlayerSaveTableDefinition,
    rows: PlayerSaveRow[],
    targetPlayerId: number,
    mode: "restore" | "clone",
    metadata: ReadonlyMap<string, PlayerSaveTableMetadata>,
): void {
    if (mode === "clone" && definition.clonePolicy === "clear") return
    const currentColumns = new Set(getMetadataColumns(database, definition.name, metadata).map(column => column.name))
    const regenerated = new Set(definition.regenerateColumns ?? [])
    const identifier = quotePlayerSaveIdentifier(definition.name)

    for (const sourceRow of rows) {
        const row: PlayerSaveRow = { ...sourceRow, player_id: targetPlayerId }
        const columns = Object.keys(row).filter(column => currentColumns.has(column) && !regenerated.has(column))
        if (columns.length === 0) continue
        const placeholders = columns.map(() => "?").join(", ")
        database.prepare(`
            INSERT INTO ${identifier} (${columns.map(quotePlayerSaveIdentifier).join(", ")})
            VALUES (${placeholders})
        `).run(...columns.map(column => row[column]))
    }
}

function applyV2SnapshotSync(
    snapshot: PlayerSaveV2Snapshot,
    targetPlayerId: number,
    mode: "restore" | "clone",
    database: Database,
): void {
    requireSafePositiveInteger(targetPlayerId, "targetPlayerId")
    const schemaMetadata = assertRegistryMatchesDatabase(database)
    const tables = flattenAndValidateV2Snapshot(snapshot, database, schemaMetadata)
    const target = database.prepare("SELECT account_id FROM players WHERE id = ?").get(targetPlayerId)
    if (target === undefined) throw new Error(`Target player ${targetPlayerId} was not found`)
    const insertionOrder = getInsertionOrder(schemaMetadata)

    database.transaction(() => {
        database.pragma("defer_foreign_keys = ON")
        for (const excluded of PLAYER_SAVE_EXCLUDED_TABLES) {
            if (excluded.reason !== "activeQuest") continue
            database.prepare(
                `DELETE FROM ${quotePlayerSaveIdentifier(excluded.name)} WHERE player_id = ?`,
            ).run(targetPlayerId)
        }
        clearGiftRedemptionsForExternalRestoreSync(targetPlayerId, database)
        for (const definition of [...insertionOrder].reverse()) {
            database.prepare(
                `DELETE FROM ${quotePlayerSaveIdentifier(definition.name)} WHERE player_id = ?`,
            ).run(targetPlayerId)
        }
        updatePlayerRoot(database, tables.get("players")![0], targetPlayerId, schemaMetadata)
        for (const definition of insertionOrder) {
            insertSnapshotRows(database, definition, tables.get(definition.name)!, targetPlayerId, mode, schemaMetadata)
        }
    })()
    clearPublishedActiveQuest(targetPlayerId)
}

export function restorePlayerSaveV2Sync(
    input: unknown,
    targetPlayerId: number,
    database: Database = getDb(),
): PlayerSaveRestoreResult {
    assertCanonicalSaveDatabase(database)
    const parsed = parsePlayerSaveSnapshot(input)
    if (parsed.kind !== "v2") throw new Error("Legacy v1 saves require the legacy partial restore path")
    applyV2SnapshotSync(parsed.snapshot, targetPlayerId, "restore", database)
    return { playerId: targetPlayerId, legacyPartial: false }
}

export function validatePlayerSaveSnapshotSync(
    input: unknown,
    database: Database = getDb(),
): ParsedPlayerSaveSnapshot {
    const parsed = parsePlayerSaveSnapshot(input)
    if (parsed.kind === "v2") {
        const schemaMetadata = assertRegistryMatchesDatabase(database)
        flattenAndValidateV2Snapshot(parsed.snapshot, database, schemaMetadata)
    }
    return parsed
}

function restoreLegacyV1SaveSync(
    input: unknown,
    targetPlayerId: number,
    database: Database,
): PlayerSaveRestoreResult {
    assertCanonicalSaveDatabase(database)
    const parsed = parsePlayerSaveSnapshot(input)
    if (parsed.kind !== "legacy-v1") throw new Error("Expected a legacy v1 player save")
    requireSafePositiveInteger(targetPlayerId, "targetPlayerId")
    const schemaMetadata = assertRegistryMatchesDatabase(database)
    if (database.prepare("SELECT id FROM players WHERE id = ?").get(targetPlayerId) === undefined) {
        throw new Error(`Target player ${targetPlayerId} was not found`)
    }

    const definitions = getInsertionOrder(schemaMetadata).filter(definition => (
        LEGACY_V1_UNMANAGED_TABLES.has(definition.name)
    ))
    const preserved = new Map(definitions.map(definition => [
        definition.name,
        selectPlayerRows(database, definition, targetPlayerId),
    ]))
    const legacyData = reviveMergedPlayerDates(parsed.snapshot.data as any)
    legacyData.player.id = targetPlayerId
    legacyData.player.timeOffset = null
    legacyData.player.expPooledTime = normalizeImportedExpPoolAnchor(
        legacyData.player.expPooledTime,
        getRealNow(),
    )

    database.transaction(() => {
        database.pragma("defer_foreign_keys = ON")
        replacePlayerDataSync(legacyData)
        clearGiftRedemptionsForExternalRestoreSync(targetPlayerId, database)
        for (const definition of [...definitions].reverse()) {
            database.prepare(
                `DELETE FROM ${quotePlayerSaveIdentifier(definition.name)} WHERE player_id = ?`,
            ).run(targetPlayerId)
        }
        for (const definition of definitions) {
            insertSnapshotRows(database, definition, preserved.get(definition.name)!, targetPlayerId, "restore", schemaMetadata)
        }
    })()
    clearPublishedActiveQuest(targetPlayerId)
    return { playerId: targetPlayerId, legacyPartial: true }
}

export function restorePlayerSaveSnapshotSync(
    input: unknown,
    targetPlayerId: number,
    database: Database = getDb(),
): PlayerSaveRestoreResult {
    assertCanonicalSaveDatabase(database)
    const parsed = parsePlayerSaveSnapshot(input)
    if (parsed.kind === "v2") return restorePlayerSaveV2Sync(parsed.snapshot, targetPlayerId, database)
    return restoreLegacyV1SaveSync(parsed.snapshot, targetPlayerId, database)
}

export function applyPlayerSaveTemplateSync(
    input: unknown,
    targetPlayerId: number,
    database: Database = getDb(),
): PlayerSaveRestoreResult {
    assertCanonicalSaveDatabase(database)
    const parsed = parsePlayerSaveSnapshot(input)
    if (parsed.kind === "v2") {
        applyV2SnapshotSync(parsed.snapshot, targetPlayerId, "clone", database)
        return { playerId: targetPlayerId, legacyPartial: false }
    }
    return restoreLegacyV1SaveSync(parsed.snapshot, targetPlayerId, database)
}

export function validatePlayerSaveTemplateSync(
    input: unknown,
    database: Database = getDb(),
): ParsedPlayerSaveSnapshot {
    assertCanonicalSaveDatabase(database)
    const parsed = validatePlayerSaveSnapshotSync(input, database)
    const rollbackMarker = {}
    try {
        database.transaction(() => {
            const now = getRealNow().toISOString()
            const account = database.prepare(`
                INSERT INTO accounts (
                    app_id, first_login_time, idp_alias, idp_code,
                    idp_id, reg_time, last_login_time, status
                ) VALUES ('wf_cn', ?, '', 'save-template-validation', ?, ?, ?, 'normal')
            `).run(now, `save-template-validation-${process.pid}-${getRealNowMs()}`, now, now)
            const player = insertDefaultPlayerSync(Number(account.lastInsertRowid))
            applyPlayerSaveTemplateSync(parsed.snapshot, player.id, database)
            throw rollbackMarker
        })()
    } catch (error) {
        if (error !== rollbackMarker) throw error
    }
    return parsed
}

export function clonePlayerSaveV2Sync(
    input: unknown,
    destinationAccountId: number,
    database: Database = getDb(),
): PlayerSaveRestoreResult {
    assertCanonicalSaveDatabase(database)
    const parsed = parsePlayerSaveSnapshot(input)
    if (parsed.kind !== "v2") throw new Error("Legacy v1 saves cannot use the full clone path")
    requireSafePositiveInteger(destinationAccountId, "destinationAccountId")
    const account = database.prepare("SELECT id FROM accounts WHERE id = ?").get(destinationAccountId)
    if (account === undefined) throw new Error(`Destination account ${destinationAccountId} was not found`)

    return database.transaction(() => {
        const sourcePlayerId = requireSafePositiveInteger(parsed.snapshot.playerId, "snapshot.playerId")
        if (database.prepare("SELECT id FROM players WHERE id = ?").get(sourcePlayerId) === undefined) {
            throw new Error(`Clone source player ${sourcePlayerId} was not found`)
        }
        const player = insertDefaultPlayerSync(destinationAccountId)
        applyV2SnapshotSync(parsed.snapshot, player.id, "clone", database)
        copyGiftRedemptionsForCloneSync(sourcePlayerId, player.id, database)
        return { playerId: player.id, legacyPartial: false }
    })()
}
