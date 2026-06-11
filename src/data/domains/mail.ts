import { getDb } from "../db";
import { getServerTime } from "../../utils";

/**
 * Mail attachment types matching the client's MailKind enum.
 */
export enum MailType {
    ITEM = 1,
    PAID_VMONEY = 3,
    FREE_VMONEY = 4,
    CHARACTER = 5,
    EQUIPMENT = 6,
    STAR_CRUMB = 7,
    FREE_MANA = 8,
    EXP_POOL = 9,
    BOND_TOKEN = 10,
    BOSS_BOOST_POINT = 11,
    BOOST_POINT = 12,
    DEGREE = 13,
    DAILY_CHALLENGE_POINT = 14,
    RANK_POINT = 15,
    PERIODIC_REWARD_POINT = 16,
    PASS_CARD_POINT = 17,
}

export interface RawPlayerMail {
    id: number
    player_id: number
    reason_id: number
    subject: string | null
    description: string | null
    type: number
    type_id: number | null
    number: number
    receive_time: string
    create_time: string
    reward_period_limited: number
    reward_limit_time: string | null
}

export interface MailAttachment {
    mail_id: number
    type: number
    type_id: number | null
    number: number
}

/**
 * Inserts a mail record for a player. Returns the auto-generated mail ID.
 */
export function insertMailSync(
    playerId: number,
    mail: Omit<RawPlayerMail, 'id' | 'player_id'>
): number {
    const result = getDb().prepare(`
        INSERT INTO players_mails (player_id, reason_id, subject, description, type, type_id, number, receive_time, create_time, reward_period_limited, reward_limit_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        playerId,
        mail.reason_id,
        mail.subject,
        mail.description,
        mail.type,
        mail.type_id,
        mail.number,
        mail.receive_time,
        mail.create_time,
        mail.reward_period_limited,
        mail.reward_limit_time
    )
    return Number(result.lastInsertRowid)
}

/**
 * Gets paginated mail list for a player.
 * @param unreceivedOnly If true, only returns unreceived mails.
 */
export function getPlayerMailsSync(
    playerId: number,
    page: number = 1,
    perPage: number = 100,
    unreceivedOnly: boolean = false
): RawPlayerMail[] {
    const offset = (page - 1) * perPage
    let query = `SELECT * FROM players_mails WHERE player_id = ?`
    if (unreceivedOnly) {
        query += ` AND receive_time = '0000-00-00 00:00:00'`
    }
    query += ` ORDER BY id DESC LIMIT ? OFFSET ?`
    return getDb().prepare(query).all(playerId, perPage, offset) as RawPlayerMail[]
}

/**
 * Gets total mail count for a player.
 */
export function getPlayerMailCountSync(
    playerId: number,
    unreceivedOnly: boolean = false
): number {
    let query = `SELECT COUNT(*) as count FROM players_mails WHERE player_id = ?`
    if (unreceivedOnly) {
        query += ` AND receive_time = '0000-00-00 00:00:00'`
    }
    const row = getDb().prepare(query).get(playerId) as { count: number }
    return row.count
}

/**
 * Marks a mail as received and returns its attachment data.
 * Does NOT apply the reward — caller must do that.
 */
export function receiveMailSync(
    playerId: number,
    mailId: number
): MailAttachment | null {
    const mail = getDb().prepare(`
        SELECT * FROM players_mails WHERE id = ? AND player_id = ? AND receive_time = '0000-00-00 00:00:00'
    `).get(mailId, playerId) as RawPlayerMail | undefined

    if (!mail) return null

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
    getDb().prepare(`UPDATE players_mails SET receive_time = ? WHERE id = ?`).run(now, mailId)

    return {
        mail_id: mail.id,
        type: mail.type,
        type_id: mail.type_id,
        number: mail.number,
    }
}

/**
 * Batch receive mails. Returns list of successfully claimed mail IDs.
 */
export function receiveAllMailsSync(
    playerId: number,
    mailIds: number[]
): number[] {
    const claimed: number[] = []
    getDb().transaction(() => {
        for (const mailId of mailIds) {
            const result = receiveMailSync(playerId, mailId)
            if (result !== null) {
                claimed.push(mailId)
            }
        }
    })()
    return claimed
}

/**
 * Receipt/History tracking — logs every reward claim for the 领取记录 feature.
 */

export interface RawReceiveHistory {
    id: number
    player_id: number
    type: number
    type_id: number | null
    number: number
    reason_id: number
    create_time: string
}

export function insertReceiveHistorySync(
    playerId: number,
    record: { type: number, type_id: number | null, number: number, reason_id?: number }
): void {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19)
    getDb().prepare(`
        INSERT INTO players_receive_history (player_id, type, type_id, number, reason_id, create_time)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(playerId, record.type, record.type_id, record.number, record.reason_id ?? 0, now)
}

export function getReceiveHistorySync(
    playerId: number,
    sinceDays: number = 7,
    limit: number = 500
): RawReceiveHistory[] {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").substring(0, 19)
    return getDb().prepare(`
        SELECT * FROM players_receive_history
        WHERE player_id = ? AND create_time >= ?
        ORDER BY create_time DESC
        LIMIT ?
    `).all(playerId, since, limit) as RawReceiveHistory[]
}
