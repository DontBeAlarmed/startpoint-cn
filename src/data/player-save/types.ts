export const PLAYER_SAVE_SCHEMA = "starpoint-cn-save" as const
export const PLAYER_SAVE_FORMAT_VERSION = 2 as const

export type PlayerSaveDomainName = "core" | "missions" | "events" | "economy" | "mailbox"

export interface PlayerSaveTableDefinition {
    readonly name: string
    readonly domain: PlayerSaveDomainName
    readonly introducedSchema: number
    readonly regenerateColumns?: readonly string[]
    readonly clonePolicy?: "clear"
}

export interface PlayerSaveExcludedTableDefinition {
    readonly name: string
    readonly reason: "activeQuest" | "serverConfig" | "serverOperation"
}

export type PlayerSaveRow = Record<string, unknown>

export interface PlayerSaveDomainSnapshot {
    version: 1
    tables: Record<string, PlayerSaveRow[]>
}

export interface PlayerSaveV2Snapshot {
    schema: typeof PLAYER_SAVE_SCHEMA
    version: typeof PLAYER_SAVE_FORMAT_VERSION
    formatVersion: typeof PLAYER_SAVE_FORMAT_VERSION
    mode: "backup"
    exportedAt: string
    playerId: number
    producer: {
        serverVersion: string
        dbSchemaVersion: number
        contentVersion: string
    }
    domains: Record<PlayerSaveDomainName, PlayerSaveDomainSnapshot>
    excludedDomains: ["account", "session", "serverConfig", "activeQuest"]
}

export interface LegacyPlayerSaveV1Snapshot {
    schema: typeof PLAYER_SAVE_SCHEMA
    version: 1
    exportedAt?: string
    playerId?: number
    data: Record<string, any>
}

export type ParsedPlayerSaveSnapshot =
    | { kind: "v2"; legacyPartial: false; snapshot: PlayerSaveV2Snapshot }
    | { kind: "legacy-v1"; legacyPartial: true; snapshot: LegacyPlayerSaveV1Snapshot }

export interface PlayerSaveRestoreResult {
    playerId: number
    legacyPartial: boolean
}
