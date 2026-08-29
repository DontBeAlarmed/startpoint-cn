import { getDb } from "../db"
import { getRealNow } from "../../runtime/time/game-time"

export interface ServerGameplaySettings {
    readonly dropMultiplier: number
    readonly multiRescueFragmentRewardsEnabled: boolean
    readonly multiRescueHostRewardsEnabled: boolean
    readonly updatedAt: string
}

interface RawServerGameplaySettings {
    readonly drop_multiplier: number
    readonly multi_rescue_fragment_rewards_enabled: number
    readonly multi_rescue_host_rewards_enabled: number
    readonly updated_at: string
}

export interface UpdateServerGameplaySettings {
    readonly dropMultiplier: number
    readonly multiRescueFragmentRewardsEnabled?: boolean
    readonly multiRescueHostRewardsEnabled?: boolean
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
        multiRescueFragmentRewardsEnabled: row.multi_rescue_fragment_rewards_enabled === 1,
        multiRescueHostRewardsEnabled: row.multi_rescue_host_rewards_enabled === 1,
        updatedAt: row.updated_at,
    }
}

export function getServerGameplaySettingsSync(): ServerGameplaySettings {
    const row = getDb().prepare(`
        SELECT drop_multiplier, multi_rescue_fragment_rewards_enabled,
            multi_rescue_host_rewards_enabled, updated_at
        FROM server_gameplay_settings
        WHERE id = 1
    `).get() as RawServerGameplaySettings | undefined
    return mapSettings(row)
}

export function updateServerGameplaySettingsSync(
    settings: UpdateServerGameplaySettings,
): ServerGameplaySettings {
    validateDropMultiplier(settings.dropMultiplier)
    if (settings.multiRescueFragmentRewardsEnabled !== undefined
        && typeof settings.multiRescueFragmentRewardsEnabled !== "boolean") {
        throw new Error("invalid multi rescue fragment reward setting")
    }
    if (settings.multiRescueHostRewardsEnabled !== undefined
        && typeof settings.multiRescueHostRewardsEnabled !== "boolean") {
        throw new Error("invalid multi rescue host reward setting")
    }
    const updatedAt = getRealNow().toISOString()
    const result = getDb().prepare(`
        UPDATE server_gameplay_settings
        SET drop_multiplier = ?,
            multi_rescue_fragment_rewards_enabled = COALESCE(?, multi_rescue_fragment_rewards_enabled),
            multi_rescue_host_rewards_enabled = COALESCE(?, multi_rescue_host_rewards_enabled),
            updated_at = ?
        WHERE id = 1
    `).run(
        settings.dropMultiplier,
        settings.multiRescueFragmentRewardsEnabled === undefined
            ? null : settings.multiRescueFragmentRewardsEnabled ? 1 : 0,
        settings.multiRescueHostRewardsEnabled === undefined
            ? null : settings.multiRescueHostRewardsEnabled ? 1 : 0,
        updatedAt,
    )
    if (result.changes !== 1) throw new Error("server gameplay settings are not initialized")
    return {
        ...getServerGameplaySettingsSync(),
        updatedAt,
    }
}
