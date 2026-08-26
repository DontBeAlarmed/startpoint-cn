import { getDb } from "../db"

export interface AdminPlayerSummary {
    readonly id: number
    readonly accountId: number
    readonly name: string
    readonly degreeId: number
    readonly rankPoint: number
}

export function getAllAdminPlayerSummariesSync(): AdminPlayerSummary[] {
    const rows = getDb().prepare(`
    SELECT id, account_id, name, degree_id, rank_point
    FROM players
    ORDER BY id
    `).all() as Array<{
        id: number
        account_id: number
        name: string
        degree_id: number
        rank_point: number
    }>

    return rows.map(row => ({
        id: row.id,
        accountId: row.account_id,
        name: row.name,
        degreeId: row.degree_id,
        rankPoint: row.rank_point,
    }))
}
