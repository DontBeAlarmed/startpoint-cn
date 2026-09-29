import { Database } from "better-sqlite3"

/**
 * 排名活动领取记录(status=1/2 判定依据)。每个 (player_id, ranking_event_id)
 * 只允许一行:首次领取成功写入,重复请求据此返回 status=2。奖励发放与领取
 * 写入必须在同一事务中,失败整体回滚。表排除在 player-save 外,玩家删除由
 * 外键级联清理。
 */
export function initializeRankingRewardClaimsSchemaSync(database: Database): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS players_ranking_reward_claims (
            player_id INTEGER NOT NULL,
            ranking_event_id INTEGER NOT NULL,
            claimed_at INTEGER NOT NULL CHECK (claimed_at >= 0),
            PRIMARY KEY (player_id, ranking_event_id),
            FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
        );
    `)
}
