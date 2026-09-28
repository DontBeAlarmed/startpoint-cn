import { getDb } from "../db"

export interface AdminPlayerSummary {
    readonly id: number
    readonly accountId: number
    readonly name: string
    readonly degreeId: number
    readonly rankPoint: number
    readonly lastLoginTime: Date
    readonly characterCount: number
}

export function getAllAdminPlayerSummariesSync(): AdminPlayerSummary[] {
    const rows = getDb().prepare(`
    SELECT id, account_id, name, degree_id, rank_point, last_login_time,
        (SELECT COUNT(*) FROM players_characters WHERE players_characters.player_id = players.id) AS character_count
    FROM players
    ORDER BY id
    `).all() as Array<{
        id: number
        account_id: number
        name: string
        degree_id: number
        rank_point: number
        last_login_time: string | number
        character_count: number
    }>

    return rows.map(row => ({
        id: row.id,
        accountId: row.account_id,
        name: row.name,
        degreeId: row.degree_id,
        rankPoint: row.rank_point,
        lastLoginTime: new Date(row.last_login_time),
        characterCount: row.character_count,
    }))
}
