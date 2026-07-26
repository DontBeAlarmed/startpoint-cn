import {
    recordDegreeBattleStatsSync,
    type DegreeBattleStats,
} from "../../data/domains/degree_battle_stats"

interface DegreeBattleStatisticsContext {
    readonly playerId: number
    readonly questAccomplished: boolean
    readonly isMulti?: boolean
    readonly statistics: {
        readonly zones?: readonly Record<string, unknown>[]
        readonly max_power?: unknown
        readonly max_skill_chain_count?: unknown
    }
}

function sumInteger(zones: readonly Record<string, unknown>[], key: string): number {
    let total = 0
    for (const zone of zones) {
        const value = zone[key]
        if (value === undefined) continue
        if (!Number.isSafeInteger(value) || (value as number) < 0) return 0
        total += value as number
        if (!Number.isSafeInteger(total)) return 0
    }
    return total
}

function sumFinite(zones: readonly Record<string, unknown>[], key: string): number {
    let total = 0
    for (const zone of zones) {
        const value = zone[key]
        if (value === undefined) continue
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0
        total += value
        if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) return 0
    }
    return total
}

function maxInteger(zones: readonly Record<string, unknown>[], key: string): number {
    let maximum = 0
    for (const zone of zones) {
        const value = zone[key]
        if (value === undefined) continue
        if (!Number.isSafeInteger(value) || (value as number) < 0) return 0
        maximum = Math.max(maximum, value as number)
    }
    return maximum
}

function maxFinite(zones: readonly Record<string, unknown>[], key: string): number {
    let maximum = 0
    for (const zone of zones) {
        const value = zone[key]
        if (value === undefined) continue
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0
        maximum = Math.max(maximum, value)
    }
    return maximum <= Number.MAX_SAFE_INTEGER ? maximum : 0
}

function topInteger(value: unknown): number {
    return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
}

export function recordDegreeBattleStatisticsSync(context: DegreeBattleStatisticsContext): void {
    if (!context.questAccomplished) return
    const zones = context.statistics.zones ?? []
    const single = context.isMulti !== true
    const multi = context.isMulti === true
    const stats: DegreeBattleStats = {
        feverCount: single ? sumInteger(zones, "fever_count") : 0,
        feverMs: single ? sumInteger(zones, "fever_ms") : 0,
        debuffEnemyCount: single ? sumInteger(zones, "use_debuff_to_enemy_count") : 0,
        clearEnemyBuffCount: single ? sumInteger(zones, "clear_buff_of_enemy_count") : 0,
        clearSelfDebuffCount: single ? sumInteger(zones, "clear_debuff_of_self_count") : 0,
        buffPartyCount: multi ? sumInteger(zones, "use_buff_to_all_party_members") : 0,
        healPartyCount: multi ? sumFinite(zones, "use_heal_to_all_party_members") : 0,
        emotionCount: multi ? sumInteger(zones, "use_emotion_count") : 0,
        enemyKillCount: sumInteger(zones, "enemy_kill_count"),
        weakPointAttackCount: sumInteger(zones, "weak_point_attack_count"),
        powerFlipLv3Count: sumInteger(zones, "use_power_flip_lv3_count"),
        coffinReducedCount: sumInteger(zones, "coffin_count_reduced_count"),
        damageDealMax: maxFinite(zones, "damage_deal_max"),
        revivalCoffinMax: maxInteger(zones, "max_coffin_count_by_revival"),
        partyPowerMax: topInteger(context.statistics.max_power),
        skillChainMax: topInteger(context.statistics.max_skill_chain_count),
    }
    recordDegreeBattleStatsSync(context.playerId, stats)
}
