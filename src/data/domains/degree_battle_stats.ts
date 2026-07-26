import { getDb } from "../db"

export interface DegreeBattleStats {
    feverCount: number
    feverMs: number
    debuffEnemyCount: number
    clearEnemyBuffCount: number
    clearSelfDebuffCount: number
    buffPartyCount: number
    healPartyCount: number
    emotionCount: number
    enemyKillCount: number
    weakPointAttackCount: number
    powerFlipLv3Count: number
    coffinReducedCount: number
    damageDealMax: number
    revivalCoffinMax: number
    partyPowerMax: number
    skillChainMax: number
}

const EMPTY: DegreeBattleStats = {
    feverCount: 0, feverMs: 0, debuffEnemyCount: 0, clearEnemyBuffCount: 0,
    clearSelfDebuffCount: 0, buffPartyCount: 0, healPartyCount: 0, emotionCount: 0,
    enemyKillCount: 0, weakPointAttackCount: 0, powerFlipLv3Count: 0,
    coffinReducedCount: 0, damageDealMax: 0, revivalCoffinMax: 0,
    partyPowerMax: 0, skillChainMax: 0,
}

export function getDegreeBattleStatsSync(playerId: number): DegreeBattleStats {
    const row = getDb().prepare(`SELECT * FROM players_degree_battle_stats WHERE player_id = ?`)
        .get(playerId) as Record<string, number> | undefined
    if (!row) return { ...EMPTY }
    return {
        feverCount: row.fever_count, feverMs: row.fever_ms,
        debuffEnemyCount: row.debuff_enemy_count,
        clearEnemyBuffCount: row.clear_enemy_buff_count,
        clearSelfDebuffCount: row.clear_self_debuff_count,
        buffPartyCount: row.buff_party_count, healPartyCount: row.heal_party_count,
        emotionCount: row.emotion_count, enemyKillCount: row.enemy_kill_count,
        weakPointAttackCount: row.weak_point_attack_count,
        powerFlipLv3Count: row.power_flip_lv3_count,
        coffinReducedCount: row.coffin_reduced_count,
        damageDealMax: row.damage_deal_max, revivalCoffinMax: row.revival_coffin_max,
        partyPowerMax: row.party_power_max, skillChainMax: row.skill_chain_max,
    }
}

export function recordDegreeBattleStatsSync(playerId: number, stats: DegreeBattleStats): void {
    getDb().prepare(`
        INSERT INTO players_degree_battle_stats VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        ) ON CONFLICT(player_id) DO UPDATE SET
            fever_count = CASE WHEN fever_count > 9007199254740991 - excluded.fever_count THEN fever_count ELSE fever_count + excluded.fever_count END,
            fever_ms = CASE WHEN fever_ms > 9007199254740991 - excluded.fever_ms THEN fever_ms ELSE fever_ms + excluded.fever_ms END,
            debuff_enemy_count = CASE WHEN debuff_enemy_count > 9007199254740991 - excluded.debuff_enemy_count THEN debuff_enemy_count ELSE debuff_enemy_count + excluded.debuff_enemy_count END,
            clear_enemy_buff_count = CASE WHEN clear_enemy_buff_count > 9007199254740991 - excluded.clear_enemy_buff_count THEN clear_enemy_buff_count ELSE clear_enemy_buff_count + excluded.clear_enemy_buff_count END,
            clear_self_debuff_count = CASE WHEN clear_self_debuff_count > 9007199254740991 - excluded.clear_self_debuff_count THEN clear_self_debuff_count ELSE clear_self_debuff_count + excluded.clear_self_debuff_count END,
            buff_party_count = CASE WHEN buff_party_count > 9007199254740991 - excluded.buff_party_count THEN buff_party_count ELSE buff_party_count + excluded.buff_party_count END,
            heal_party_count = CASE WHEN heal_party_count > 9007199254740991 - excluded.heal_party_count THEN heal_party_count ELSE heal_party_count + excluded.heal_party_count END,
            emotion_count = CASE WHEN emotion_count > 9007199254740991 - excluded.emotion_count THEN emotion_count ELSE emotion_count + excluded.emotion_count END,
            enemy_kill_count = CASE WHEN enemy_kill_count > 9007199254740991 - excluded.enemy_kill_count THEN enemy_kill_count ELSE enemy_kill_count + excluded.enemy_kill_count END,
            weak_point_attack_count = CASE WHEN weak_point_attack_count > 9007199254740991 - excluded.weak_point_attack_count THEN weak_point_attack_count ELSE weak_point_attack_count + excluded.weak_point_attack_count END,
            power_flip_lv3_count = CASE WHEN power_flip_lv3_count > 9007199254740991 - excluded.power_flip_lv3_count THEN power_flip_lv3_count ELSE power_flip_lv3_count + excluded.power_flip_lv3_count END,
            coffin_reduced_count = CASE WHEN coffin_reduced_count > 9007199254740991 - excluded.coffin_reduced_count THEN coffin_reduced_count ELSE coffin_reduced_count + excluded.coffin_reduced_count END,
            damage_deal_max = MAX(damage_deal_max, excluded.damage_deal_max),
            revival_coffin_max = MAX(revival_coffin_max, excluded.revival_coffin_max),
            party_power_max = MAX(party_power_max, excluded.party_power_max),
            skill_chain_max = MAX(skill_chain_max, excluded.skill_chain_max)
    `).run(playerId, stats.feverCount, stats.feverMs, stats.debuffEnemyCount,
        stats.clearEnemyBuffCount, stats.clearSelfDebuffCount, stats.buffPartyCount,
        stats.healPartyCount, stats.emotionCount, stats.enemyKillCount,
        stats.weakPointAttackCount, stats.powerFlipLv3Count, stats.coffinReducedCount,
        stats.damageDealMax, stats.revivalCoffinMax, stats.partyPowerMax, stats.skillChainMax)
}
