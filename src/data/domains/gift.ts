import { getDb } from "../db"
import {
    GiftCodeValidationError,
    GiftRewardValidationError,
    validateGiftDraft,
    validateGiftCode,
    validateGiftRewards,
} from "../../lib/gift-code/validation"
import type {
    GiftDefinition,
    GiftDefinitionPage,
    GiftDraft,
    GiftReward,
    GiftStatus,
} from "../../lib/gift-code/types"
import { getRealNow } from "../../runtime/time/game-time"

export class GiftNotFoundError extends Error {
    constructor() {
        super("Gift not found")
        this.name = "GiftNotFoundError"
    }
}

export class GiftRevisionConflictError extends Error {
    constructor() {
        super("Gift revision conflict")
        this.name = "GiftRevisionConflictError"
    }
}

export class GiftStateError extends Error {
    constructor() {
        super("Gift status does not permit this operation")
        this.name = "GiftStateError"
    }
}

export class GiftCodeConflictError extends Error {
    constructor() {
        super("Gift code already exists")
        this.name = "GiftCodeConflictError"
    }
}

function requirePositiveInteger(value: number, label: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`${label} must be a positive integer`)
    }
    return value
}

function requirePagination(page: number, pageSize: number): { limit: number; offset: number } {
    requirePositiveInteger(page, "Gift page")
    requirePositiveInteger(pageSize, "Gift page size")
    if (pageSize > 100) throw new TypeError("Gift page size must be an integer from 1 through 100")
    return { limit: pageSize, offset: (page - 1) * pageSize }
}

function areRewardsEqual(left: readonly GiftReward[], right: readonly GiftReward[]): boolean {
    return left.length === right.length && left.every((reward, index) => (
        reward.position === right[index]?.position
        && reward.type === right[index]?.type
        && reward.typeId === right[index]?.typeId
        && reward.number === right[index]?.number
    ))
}

function loadRewards(id: number): GiftReward[] {
    return getDb().prepare(
        "SELECT position, type, type_id AS typeId, number FROM server_gift_rewards WHERE gift_id = ? ORDER BY position",
    ).all(id) as GiftReward[]
}

function rowToGift(row: Record<string, unknown>): GiftDefinition {
    const id = row.id as number
    return {
        id,
        code: row.code as string,
        status: row.status as GiftStatus,
        note: (row.note ?? null) as string | null,
        rewardRevision: row.reward_revision as number,
        revision: row.revision as number,
        rewards: loadRewards(id),
        redemptionCount: row.redemption_count === undefined
            ? (getDb().prepare(
                "SELECT COUNT(*) AS count FROM players_gift_redemptions WHERE gift_id = ?",
            ).get(id) as { count: number }).count
            : row.redemption_count as number,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
    }
}

function insertRewards(id: number, rewards: readonly GiftReward[]): void {
    const statement = getDb().prepare(`
        INSERT INTO server_gift_rewards (gift_id, position, type, type_id, number)
        VALUES (?, ?, ?, ?, ?)
    `)
    for (const reward of rewards) {
        statement.run(id, reward.position, reward.type, reward.typeId, reward.number)
    }
}

export function createGiftSync(input: GiftDraft): GiftDefinition {
    const draft = validateGiftDraft(input)
    const timestamp = getRealNow().toISOString()
    const database = getDb()
    const createdId = database.transaction(() => {
        const existing = database.prepare(
            "SELECT id FROM server_gift_codes WHERE code = ?",
        ).get(draft.code)
        if (existing !== undefined) throw new GiftCodeConflictError()
        const result = database.prepare(`
            INSERT INTO server_gift_codes (code, status, note, created_at, updated_at)
            VALUES (?, 'stopped', ?, ?, ?)
        `).run(draft.code, draft.note, timestamp, timestamp)
        const id = Number(result.lastInsertRowid)
        insertRewards(id, draft.rewards)
        return id
    })()
    return getGiftSync(createdId) as GiftDefinition
}

export function updateStoppedGiftSync(
    id: number,
    revision: number,
    input: GiftDraft,
): GiftDefinition {
    const giftId = requirePositiveInteger(id, "Gift ID")
    const currentRevision = requirePositiveInteger(revision, "Gift revision")
    const draft = validateGiftDraft(input)
    const database = getDb()
    database.transaction(() => {
        const current = database.prepare(
            "SELECT * FROM server_gift_codes WHERE id = ?",
        ).get(giftId) as Record<string, unknown> | undefined
        if (current === undefined) throw new GiftNotFoundError()
        if (current.status !== "stopped") throw new GiftStateError()
        if (current.revision !== currentRevision) throw new GiftRevisionConflictError()

        const duplicate = database.prepare(
            "SELECT id FROM server_gift_codes WHERE code = ? AND id <> ?",
        ).get(draft.code, giftId)
        if (duplicate !== undefined) throw new GiftCodeConflictError()

        const currentRewards = loadRewards(giftId)
        const rewardRevision = areRewardsEqual(currentRewards, draft.rewards)
            ? current.reward_revision as number
            : current.reward_revision as number + 1
        const result = database.prepare(`
            UPDATE server_gift_codes
            SET code = ?,
                note = ?,
                reward_revision = ?,
                revision = revision + 1,
                updated_at = ?
            WHERE id = ? AND revision = ? AND status = 'stopped'
        `).run(
            draft.code,
            draft.note,
            rewardRevision,
            getRealNow().toISOString(),
            giftId,
            currentRevision,
        )
        if (result.changes !== 1) throw new GiftRevisionConflictError()
        if (!areRewardsEqual(currentRewards, draft.rewards)) {
            database.prepare("DELETE FROM server_gift_rewards WHERE gift_id = ?").run(giftId)
            insertRewards(giftId, draft.rewards)
        }
    })()
    return getGiftSync(giftId) as GiftDefinition
}

export function startGiftSync(id: number, revision: number): GiftDefinition {
    const giftId = requirePositiveInteger(id, "Gift ID")
    const currentRevision = requirePositiveInteger(revision, "Gift revision")
    const database = getDb()
    database.transaction(() => {
        const current = database.prepare(
            "SELECT * FROM server_gift_codes WHERE id = ?",
        ).get(giftId) as Record<string, unknown> | undefined
        if (current === undefined) throw new GiftNotFoundError()
        if (current.status !== "stopped") throw new GiftStateError()
        if (current.revision !== currentRevision) throw new GiftRevisionConflictError()

        const code = current.code
        if (typeof code !== "string") throw new GiftCodeValidationError()
        validateGiftCode(code)
        const rewards = database.prepare(`
            SELECT position, type, type_id AS typeId, number
            FROM server_gift_rewards
            WHERE gift_id = ?
            ORDER BY position
        `).all(giftId) as GiftReward[]
        validateGiftRewards(rewards)

        const result = database.prepare(`
            UPDATE server_gift_codes
            SET status = 'active',
                revision = revision + 1,
                updated_at = ?
            WHERE id = ? AND revision = ? AND status = 'stopped'
        `).run(getRealNow().toISOString(), giftId, currentRevision)
        if (result.changes !== 1) throw new GiftRevisionConflictError()
    })()
    return getGiftSync(giftId) as GiftDefinition
}

export function stopGiftSync(id: number, revision: number): GiftDefinition {
    const giftId = requirePositiveInteger(id, "Gift ID")
    const currentRevision = requirePositiveInteger(revision, "Gift revision")
    const database = getDb()
    const result = database.prepare(`
        UPDATE server_gift_codes
        SET status = 'stopped',
            revision = revision + 1,
            updated_at = ?
        WHERE id = ? AND revision = ? AND status = 'active'
    `).run(getRealNow().toISOString(), giftId, currentRevision)
    if (result.changes !== 1) {
        if (getDb().prepare("SELECT 1 FROM server_gift_codes WHERE id = ?").get(giftId) === undefined) {
            throw new GiftNotFoundError()
        }
        const current = getDb().prepare("SELECT status, revision FROM server_gift_codes WHERE id = ?")
            .get(giftId) as { status: GiftStatus; revision: number }
        if (current.status !== "active") throw new GiftStateError()
        throw new GiftRevisionConflictError()
    }
    return getGiftSync(giftId) as GiftDefinition
}

export function deleteStoppedGiftSync(id: number, revision: number): void {
    const giftId = requirePositiveInteger(id, "Gift ID")
    const currentRevision = requirePositiveInteger(revision, "Gift revision")
    const result = getDb().prepare(`
        DELETE FROM server_gift_codes
        WHERE id = ? AND revision = ? AND status = 'stopped'
    `).run(giftId, currentRevision)
    if (result.changes !== 1) {
        if (getDb().prepare("SELECT 1 FROM server_gift_codes WHERE id = ?").get(giftId) === undefined) {
            throw new GiftNotFoundError()
        }
        const current = getDb().prepare("SELECT status, revision FROM server_gift_codes WHERE id = ?")
            .get(giftId) as { status: GiftStatus; revision: number }
        if (current.status !== "stopped") throw new GiftStateError()
        throw new GiftRevisionConflictError()
    }
}

export function listGiftsSync(page: number, pageSize: number): GiftDefinitionPage {
    const pagination = requirePagination(page, pageSize)
    const database = getDb()
    const rows = database.prepare(`
        SELECT codes.*, (
            SELECT COUNT(*)
            FROM players_gift_redemptions AS redemptions
            WHERE redemptions.gift_id = codes.id
        ) AS redemption_count
        FROM server_gift_codes AS codes
        ORDER BY codes.id DESC
        LIMIT ? OFFSET ?
    `).all(pagination.limit, pagination.offset)
        .map(row => rowToGift(row as Record<string, unknown>))
    const count = database.prepare(
        "SELECT COUNT(*) AS count FROM server_gift_codes",
    ).get() as { count: number }
    return { rows, totalCount: count.count, page, pageSize }
}

export function getGiftSync(id: number): GiftDefinition | null {
    requirePositiveInteger(id, "Gift ID")
    const row = getDb().prepare(`
        SELECT codes.*, (
            SELECT COUNT(*)
            FROM players_gift_redemptions AS redemptions
            WHERE redemptions.gift_id = codes.id
        ) AS redemption_count
        FROM server_gift_codes AS codes
        WHERE codes.id = ?
    `).get(id) as Record<string, unknown> | undefined
    return row === undefined ? null : rowToGift(row)
}

export function getGiftByExactCodeSync(code: string): GiftDefinition | null {
    if (typeof code !== "string") return null
    const row = getDb().prepare(`
        SELECT codes.*, (
            SELECT COUNT(*)
            FROM players_gift_redemptions AS redemptions
            WHERE redemptions.gift_id = codes.id
        ) AS redemption_count
        FROM server_gift_codes AS codes
        WHERE codes.code = ?
    `).get(code) as Record<string, unknown> | undefined
    return row === undefined ? null : rowToGift(row)
}
