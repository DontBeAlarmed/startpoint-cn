import { getDb } from "../db"
import { getRealNow } from "../../runtime/time/game-time"

export interface ServerGameplaySettings {
    readonly dropMultiplier: number
    readonly updatedAt: string
}

interface RawServerGameplaySettings {
    readonly drop_multiplier: number
    readonly updated_at: string
}

export interface UpdateServerGameplaySettings {
    readonly dropMultiplier: number
}

function validateDropMultiplier(value: unknown): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10) {
        throw new Error("invalid drop multiplier; expected an integer between 1 and 10")
    }
}

function mapSettings(row: RawServerGameplaySettings | undefined): ServerGameplaySettings {
    if (row === undefined) throw new Error("server gameplay settings are not initialized")
    return {
        dropMultiplier: row.drop_multiplier,
        updatedAt: row.updated_at,
    }
}

export function getServerGameplaySettingsSync(): ServerGameplaySettings {
    const row = getDb().prepare(`
        SELECT drop_multiplier, updated_at
        FROM server_gameplay_settings
        WHERE id = 1
    `).get() as RawServerGameplaySettings | undefined
    return mapSettings(row)
}

export function updateServerGameplaySettingsSync(
    settings: UpdateServerGameplaySettings,
): ServerGameplaySettings {
    validateDropMultiplier(settings.dropMultiplier)
    const updatedAt = getRealNow().toISOString()
    const result = getDb().prepare(`
        UPDATE server_gameplay_settings
        SET drop_multiplier = ?, updated_at = ?
        WHERE id = 1
    `).run(settings.dropMultiplier, updatedAt)
    if (result.changes !== 1) throw new Error("server gameplay settings are not initialized")
    return { dropMultiplier: settings.dropMultiplier, updatedAt }
}
