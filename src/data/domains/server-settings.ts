import { getDb } from "../db"
import { getRealNow } from "../../runtime/time/game-time"

export interface ServerGameplaySettings {
    readonly dropMultiplier: number
    readonly multiRescueFragmentRewardsEnabled: boolean
    readonly multiRescueHostRewardsEnabled: boolean
    readonly rush700011To700017CompatibilityEnabled: boolean
    readonly multiRandomRecruitmentPublishEnabled: boolean
    readonly multiNpcReleaseSeconds: number
    readonly multiNpcCloseRecruitmentAfterFill: boolean
    readonly multiNpcOneShotLifecycle: boolean
    readonly updatedAt: string
}

interface RawServerGameplaySettings {
    readonly drop_multiplier: number
    readonly multi_rescue_fragment_rewards_enabled: number
    readonly multi_rescue_host_rewards_enabled: number
    readonly rush_700011_to_700017_compatibility_enabled: number
    readonly multi_random_recruitment_publish_enabled: number
    readonly multi_npc_release_seconds: number
    readonly multi_npc_close_recruitment_after_fill: number
    readonly multi_npc_one_shot_lifecycle: number
    readonly updated_at: string
}

export interface UpdateServerGameplaySettings {
    readonly dropMultiplier: number
    readonly multiRescueFragmentRewardsEnabled?: boolean
    readonly multiRescueHostRewardsEnabled?: boolean
    readonly rush700011To700017CompatibilityEnabled?: boolean
    readonly multiRandomRecruitmentPublishEnabled?: boolean
    readonly multiNpcReleaseSeconds?: number
    readonly multiNpcCloseRecruitmentAfterFill?: boolean
    readonly multiNpcOneShotLifecycle?: boolean
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
        rush700011To700017CompatibilityEnabled: row.rush_700011_to_700017_compatibility_enabled === 1,
        multiRandomRecruitmentPublishEnabled: row.multi_random_recruitment_publish_enabled === 1,
        multiNpcReleaseSeconds: row.multi_npc_release_seconds,
        multiNpcCloseRecruitmentAfterFill: row.multi_npc_close_recruitment_after_fill === 1,
        multiNpcOneShotLifecycle: row.multi_npc_one_shot_lifecycle === 1,
        updatedAt: row.updated_at,
    }
}

export function getServerGameplaySettingsSync(): ServerGameplaySettings {
    const row = getDb().prepare(`
        SELECT drop_multiplier, multi_rescue_fragment_rewards_enabled,
            multi_rescue_host_rewards_enabled,
            rush_700011_to_700017_compatibility_enabled,
            multi_random_recruitment_publish_enabled, multi_npc_release_seconds,
            multi_npc_close_recruitment_after_fill, multi_npc_one_shot_lifecycle,
            updated_at
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
    if (settings.rush700011To700017CompatibilityEnabled !== undefined
        && typeof settings.rush700011To700017CompatibilityEnabled !== "boolean") {
        throw new Error("invalid rush 700011 to 700017 compatibility setting")
    }
    if (settings.multiRandomRecruitmentPublishEnabled !== undefined
        && typeof settings.multiRandomRecruitmentPublishEnabled !== "boolean") {
        throw new Error("invalid multi random recruitment publish setting")
    }
    if (settings.multiNpcReleaseSeconds !== undefined
        && (!Number.isSafeInteger(settings.multiNpcReleaseSeconds)
            || (settings.multiNpcReleaseSeconds as number) < 0
            || (settings.multiNpcReleaseSeconds as number) > 86400)) {
        throw new Error("invalid multi npc release seconds; expected an integer between 0 and 86400")
    }
    if (settings.multiNpcCloseRecruitmentAfterFill !== undefined
        && typeof settings.multiNpcCloseRecruitmentAfterFill !== "boolean") {
        throw new Error("invalid multi npc close recruitment after fill setting")
    }
    if (settings.multiNpcOneShotLifecycle !== undefined
        && typeof settings.multiNpcOneShotLifecycle !== "boolean") {
        throw new Error("invalid multi npc one shot lifecycle setting")
    }
    const updatedAt = getRealNow().toISOString()
    const result = getDb().prepare(`
        UPDATE server_gameplay_settings
        SET drop_multiplier = ?,
            multi_rescue_fragment_rewards_enabled = COALESCE(?, multi_rescue_fragment_rewards_enabled),
            multi_rescue_host_rewards_enabled = COALESCE(?, multi_rescue_host_rewards_enabled),
            rush_700011_to_700017_compatibility_enabled = COALESCE(?, rush_700011_to_700017_compatibility_enabled),
            multi_random_recruitment_publish_enabled = COALESCE(?, multi_random_recruitment_publish_enabled),
            multi_npc_release_seconds = COALESCE(?, multi_npc_release_seconds),
            multi_npc_close_recruitment_after_fill = COALESCE(?, multi_npc_close_recruitment_after_fill),
            multi_npc_one_shot_lifecycle = COALESCE(?, multi_npc_one_shot_lifecycle),
            updated_at = ?
        WHERE id = 1
    `).run(
        settings.dropMultiplier,
        settings.multiRescueFragmentRewardsEnabled === undefined
            ? null : settings.multiRescueFragmentRewardsEnabled ? 1 : 0,
        settings.multiRescueHostRewardsEnabled === undefined
            ? null : settings.multiRescueHostRewardsEnabled ? 1 : 0,
        settings.rush700011To700017CompatibilityEnabled === undefined
            ? null : settings.rush700011To700017CompatibilityEnabled ? 1 : 0,
        settings.multiRandomRecruitmentPublishEnabled === undefined
            ? null : settings.multiRandomRecruitmentPublishEnabled ? 1 : 0,
        settings.multiNpcReleaseSeconds === undefined ? null : settings.multiNpcReleaseSeconds,
        settings.multiNpcCloseRecruitmentAfterFill === undefined
            ? null : settings.multiNpcCloseRecruitmentAfterFill ? 1 : 0,
        settings.multiNpcOneShotLifecycle === undefined
            ? null : settings.multiNpcOneShotLifecycle ? 1 : 0,
        updatedAt,
    )
    if (result.changes !== 1) throw new Error("server gameplay settings are not initialized")
    return {
        ...getServerGameplaySettingsSync(),
        updatedAt,
    }
}
