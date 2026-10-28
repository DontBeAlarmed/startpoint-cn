import pg from "pg"

/**
 * PG 后端（W1b）：跨物理机部署时共享社交状态的真正网络后端。设置
 * MULTI_SOCIAL_PG_URL（postgres:// 连接串）后，四个社交域的 Store 由
 * 共享 SQLite 切换到 PG——SQLite 共享文件仅支持同机多进程（WAL 不支持
 * NFS/SMB），跨物理机必须走网络数据库。
 *
 * 节点命名空间（W1c）：各服本地 viewer_id/player_id 取值区间重叠，共享表
 * 的裸键会产生跨服假关联。所有共享表主键/谓词从第一天起携带 node_id
 * （部署侧为每个游戏服分配一个稳定的 node 标识，env MULTI_NODE_ID）。
 *
 * 接线状态（W1b 分期）：presence 已切换 PG；attention/follows/room-shares
 * 的 PG store 已实现（pg-*.ts / pg-attention-store.ts），env 接线与契约
 * 测试矩阵属 W1c——设 MULTI_SOCIAL_PG_URL 当前只切 presence。
 * 连接纪律：单 Pool（PG 自带连接复用）+ 幂等 DDL + 无外键（与 SQLite
 * 形态一致）。写并发由 PG 的 MVCC 处理，无 busy_timeout 概念。
 */

export const PG_POOL_MAX = (() => {
    const parsed = Number(process.env.MULTI_SOCIAL_PG_POOL_MAX ?? "")
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 10
})()

let pgPool: pg.Pool | null = null

export function getPgPool(): pg.Pool {
    if (pgPool === null) {
        pgPool = new pg.Pool({
            connectionString: process.env.MULTI_SOCIAL_PG_URL,
            max: PG_POOL_MAX,
        })
        // 空闲连接出错（PG 重启/网络闪断）时 Pool emit "error"——无监听器
        // 会作为 uncaught exception 打死整个游戏服进程
        pgPool.on("error", error => {
            console.warn("[SOCIAL-PG] idle client error (pool continues)", error.message)
        })
    }
    return pgPool
}

export async function ensurePgSocialSchema(): Promise<void> {
    const pool = getPgPool()
    await pool.query(`
        CREATE TABLE IF NOT EXISTS social_presence (
            node_id TEXT NOT NULL,
            viewer_id BIGINT NOT NULL,
            last_seen_ms BIGINT NOT NULL,
            PRIMARY KEY (node_id, viewer_id)
        )
    `)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS attention_recruitments (
            id BIGSERIAL PRIMARY KEY,
            node_id TEXT NOT NULL,
            attention_key TEXT NOT NULL,
            room_number TEXT NOT NULL,
            host_pid BIGINT NOT NULL,
            host_viewer_id BIGINT NOT NULL,
            category INTEGER NOT NULL,
            quest_id BIGINT NOT NULL,
            is_newbie_host SMALLINT NOT NULL,
            establisher_json TEXT NOT NULL,
            posted_at_ms BIGINT NOT NULL,
            expires_at_ms BIGINT NOT NULL,
            status TEXT NOT NULL,
            UNIQUE (node_id, attention_key)
        )
    `)
    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_room_open
            ON attention_recruitments (node_id, host_viewer_id, room_number)
            WHERE status = 'open'
    `)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS attention_deliveries (
            recruitment_id BIGINT NOT NULL,
            viewer_id BIGINT NOT NULL,
            state TEXT NOT NULL,
            acted_at_ms BIGINT,
            PRIMARY KEY (recruitment_id, viewer_id)
        )
    `)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS social_follows (
            node_id TEXT NOT NULL,
            follower_viewer_id BIGINT NOT NULL,
            followed_viewer_id BIGINT NOT NULL,
            followed_at_ms BIGINT NOT NULL,
            PRIMARY KEY (node_id, follower_viewer_id, followed_viewer_id)
        )
    `)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS social_room_shares (
            node_id TEXT NOT NULL,
            room_number TEXT NOT NULL,
            host_viewer_id BIGINT NOT NULL,
            category_id INTEGER NOT NULL,
            quest_id BIGINT NOT NULL,
            share_bits INTEGER NOT NULL,
            raising_state INTEGER NOT NULL,
            mates INTEGER NOT NULL,
            establisher_json TEXT NOT NULL,
            created_at_ms BIGINT NOT NULL,
            updated_at_ms BIGINT NOT NULL,
            expires_at_ms BIGINT NOT NULL,
            PRIMARY KEY (node_id, room_number)
        )
    `)
}

/** 部署侧为每个游戏服分配的稳定节点标识（跨服共享表命名空间键） */
export function getNodeNamespace(): string {
    const raw = process.env.MULTI_NODE_ID?.trim()
    if (raw === undefined || raw === "") {
        throw new Error(
            "MULTI_SOCIAL_PG_URL 需要配套 MULTI_NODE_ID（跨服共享表的节点命名空间键）",
        )
    }
    return raw
}

export async function closePgPool(): Promise<void> {
    if (pgPool !== null) {
        await pgPool.end()
        pgPool = null
    }
}
