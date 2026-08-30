import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { getDatabaseStatus } from "../../data"
import { getDb } from "../../data/db"
import {
    createGiftSync,
    deleteStoppedGiftSync,
    getGiftSync,
    listGiftsSync,
    startGiftSync,
    stopGiftSync,
    updateStoppedGiftSync,
    GiftCodeConflictError,
    GiftNotFoundError,
    GiftRevisionConflictError,
    GiftStateError,
} from "../../data/domains/gift"
import {
    GiftCodeValidationError,
    GiftDraftValidationError,
    GiftRewardValidationError,
    validateGiftDraft,
} from "../../lib/gift-code/validation"
import type { GiftDraft, GiftReward } from "../../lib/gift-code/types"

interface GiftParams {
    readonly id: string
}

interface RedemptionRecord {
    readonly playerId: number
    readonly accountId: number
    readonly playerName: string
    readonly redeemedAt: string
    readonly rewardRevision: number
    readonly rewardSnapshot: readonly GiftReward[]
    readonly sourcePlayerId: number | null
}

interface RawRedemptionRecord extends Omit<RedemptionRecord, "rewardSnapshot"> {
    readonly rewardSnapshot: string
}

class GiftRequestValidationError extends Error {
    constructor() {
        super("Invalid gift request")
        this.name = "GiftRequestValidationError"
    }
}

class GiftRedemptionSnapshotError extends Error {
    constructor() {
        super("Invalid gift redemption snapshot")
        this.name = "GiftRedemptionSnapshotError"
    }
}

function isDatabaseReady(): boolean {
    return getDatabaseStatus().ready
}

function parseInteger(value: string, maximum = Number.MAX_SAFE_INTEGER): number | null {
    if (!/^[1-9]\d*$/.test(value)) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null
}

function requireGiftId(request: FastifyRequest, reply: FastifyReply): number | null {
    const id = parseInteger((request.params as GiftParams).id)
    if (id === null) {
        void reply.status(404).send({ error: "礼包不存在" })
        return null
    }
    return id
}

function requireRevision(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new GiftRequestValidationError()
    }
    return value
}

function requireDraftBody(body: unknown): GiftDraft {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new GiftRequestValidationError()
    }
    const { revision, ...draft } = body as Record<string, unknown>
    requireRevision(revision)
    return validateGiftDraft(draft)
}

function parseRewardSnapshot(rawSnapshot: string): readonly GiftReward[] {
    let parsed: unknown
    try {
        parsed = JSON.parse(rawSnapshot)
    } catch {
        throw new GiftRedemptionSnapshotError()
    }
    if (!Array.isArray(parsed)) throw new GiftRedemptionSnapshotError()

    return Object.freeze(parsed.map((item, position): GiftReward => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
            throw new GiftRedemptionSnapshotError()
        }
        const record = item as Record<string, unknown>
        const rawType = record.type
        if (rawType !== 1 && rawType !== 4 && rawType !== 5
            && rawType !== 6 && rawType !== 8 && rawType !== 9) {
            throw new GiftRedemptionSnapshotError()
        }
        const rawTypeId = record.type_id
        const hasTypeId = rawType === 1 || rawType === 5 || rawType === 6
        let typeId: number | null
        if (hasTypeId) {
            if (rawTypeId === null || rawTypeId === undefined
                || typeof rawTypeId !== "number"
                || !Number.isSafeInteger(rawTypeId)
                || rawTypeId < 1) {
                throw new GiftRedemptionSnapshotError()
            }
            typeId = rawTypeId
        } else if (rawTypeId !== null && rawTypeId !== undefined) {
            throw new GiftRedemptionSnapshotError()
        } else {
            typeId = null
        }
        const rawNumber = record.number
        if (typeof rawNumber !== "number"
            || !Number.isSafeInteger(rawNumber)
            || rawNumber < 1
            || rawNumber > 2147483647) {
            throw new GiftRedemptionSnapshotError()
        }
        const rawPosition = record.position
        if (rawPosition !== position
            || typeof rawPosition !== "number"
            || !Number.isSafeInteger(rawPosition)) {
            throw new GiftRedemptionSnapshotError()
        }
        return Object.freeze({
            position: rawPosition,
            type: rawType,
            typeId,
            number: rawNumber,
        })
    }))
}

const BACKSLASH = String.fromCharCode(92)

function escapeLikePattern(value: string): string {
    return value
        .split(BACKSLASH).join(BACKSLASH + BACKSLASH)
        .split("%").join(BACKSLASH + "%")
        .split("_").join(BACKSLASH + "_")
}

function listRedemptions(
    giftId: number,
    page: number,
    pageSize: number,
    search: string | undefined,
): { rows: readonly RedemptionRecord[]; totalCount: number } {
    const db = getDb()
    const hasSearch = search !== undefined
    const exactId = hasSearch ? parseInteger(search) : null
    const isExactId = exactId !== null
    const namePattern = hasSearch ? `%${escapeLikePattern(search)}%` : null
    const escapeCharacter = BACKSLASH
    const where = `WHERE r.gift_id = ?${hasSearch
        ? (isExactId
            ? " AND (r.player_id = ? OR p.account_id = ? OR p.name LIKE ? ESCAPE ?)"
            : " AND p.name LIKE ? ESCAPE ?")
        : ""}`
    const parameters = hasSearch
        ? (isExactId
            ? [giftId, exactId, exactId, namePattern, escapeCharacter]
            : [giftId, namePattern, escapeCharacter])
        : [giftId]
    const countRow = db.prepare(`
        SELECT COUNT(*) AS totalCount
        FROM players_gift_redemptions AS r
        INNER JOIN players AS p ON p.id = r.player_id
        ${where}
    `).get(...parameters) as { totalCount: number }
    const rows = db.prepare(`
        SELECT
            r.player_id AS playerId,
            p.account_id AS accountId,
            p.name AS playerName,
            r.redeemed_at AS redeemedAt,
            r.reward_revision AS rewardRevision,
            r.reward_snapshot AS rewardSnapshot,
            r.inherited_from_player_id AS sourcePlayerId
        FROM players_gift_redemptions AS r
        INNER JOIN players AS p ON p.id = r.player_id
        ${where}
        ORDER BY r.redeemed_at DESC, r.player_id DESC
        LIMIT ? OFFSET ?
    `).all(
        ...parameters,
        pageSize,
        (page - 1) * pageSize,
    ) as readonly RawRedemptionRecord[]

    return {
        totalCount: countRow.totalCount,
        rows: rows.map(row => ({
            ...row,
            inherited: row.sourcePlayerId !== null,
            rewardSnapshot: parseRewardSnapshot(row.rewardSnapshot),
        })),
    }
}

function sendRouteError(
    request: FastifyRequest,
    reply: FastifyReply,
    error: unknown,
): FastifyReply {
    if (error instanceof GiftRedemptionSnapshotError) {
        request.log.error(
            { code: "ADMIN_GIFT_REDEMPTION_SNAPSHOT_INVALID" },
            "Admin gift redemption snapshot is invalid",
        )
        return reply.status(500).send({ error: "礼包操作失败" })
    }
    if (error instanceof GiftNotFoundError) {
        return reply.status(404).send({ error: "礼包不存在" })
    }
    if (error instanceof GiftRevisionConflictError) {
        return reply.status(409).send({ error: "礼包已被其他操作修改，请刷新" })
    }
    if (error instanceof GiftStateError) {
        return reply.status(409).send({ error: "礼包状态不允许该操作" })
    }
    if (error instanceof GiftCodeConflictError) {
        return reply.status(409).send({ error: "礼包 code 已存在" })
    }
    if (error instanceof GiftDraftValidationError
        || error instanceof GiftCodeValidationError
        || error instanceof GiftRewardValidationError
        || error instanceof GiftRequestValidationError) {
        return reply.status(400).send({ error: "礼包内容无效" })
    }
    request.log.error({ code: "ADMIN_GIFT_OPERATION_FAILED" }, "Admin gift operation failed")
    return reply.status(500).send({ error: "礼包操作失败" })
}

function requirePagination(query: { page?: string; pageSize?: string }) {
    const page = query.page === undefined ? 1 : parseInteger(query.page)
    const pageSize = query.pageSize === undefined ? 20 : parseInteger(query.pageSize, 100)
    if (page === null || pageSize === null) throw new GiftRequestValidationError()
    return { page, pageSize }
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        try {
            const { page, pageSize } = requirePagination(request.query as never)
            return reply.status(200).send(listGiftsSync(page, pageSize))
        } catch (error) {
            return sendRouteError(request, reply, error)
        }
    })

    fastify.post("/", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        try {
            return reply.status(201).send(createGiftSync(validateGiftDraft(request.body)))
        } catch (error) {
            return sendRouteError(request, reply, error)
        }
    })

    fastify.get("/:id", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        const id = requireGiftId(request, reply)
        if (id === null) return reply
        try {
            const gift = getGiftSync(id)
            if (gift === null) return reply.status(404).send({ error: "礼包不存在" })
            return reply.status(200).send(gift)
        } catch (error) {
            return sendRouteError(request, reply, error)
        }
    })

    fastify.patch("/:id", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        const id = requireGiftId(request, reply)
        if (id === null) return reply
        try {
            const body = request.body as Record<string, unknown>
            const revision = requireRevision(body?.revision)
            return reply.status(200).send(
                updateStoppedGiftSync(id, revision, requireDraftBody(request.body)),
            )
        } catch (error) {
            return sendRouteError(request, reply, error)
        }
    })

    fastify.post("/:id/start", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        const id = requireGiftId(request, reply)
        if (id === null) return reply
        try {
            const revision = requireRevision(
                (request.body as { revision?: unknown } | null)?.revision,
            )
            return reply.status(200).send(startGiftSync(id, revision))
        } catch (error) {
            return sendRouteError(request, reply, error)
        }
    })

    fastify.post("/:id/stop", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        const id = requireGiftId(request, reply)
        if (id === null) return reply
        try {
            const revision = requireRevision(
                (request.body as { revision?: unknown } | null)?.revision,
            )
            return reply.status(200).send(stopGiftSync(id, revision))
        } catch (error) {
            return sendRouteError(request, reply, error)
        }
    })

    fastify.delete("/:id", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        const id = requireGiftId(request, reply)
        if (id === null) return reply
        try {
            const revisionValue = (request.query as { revision?: string }).revision
            const revision = revisionValue === undefined ? null : parseInteger(revisionValue)
            if (revision === null) throw new GiftRequestValidationError()
            deleteStoppedGiftSync(id, revision)
            return reply.status(200).send({ ok: true })
        } catch (error) {
            return sendRouteError(request, reply, error)
        }
    })

    fastify.get("/:id/redemptions", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        const id = requireGiftId(request, reply)
        if (id === null) return reply
        try {
            const query = request.query as { page?: string; pageSize?: string; q?: string }
            const { page, pageSize } = requirePagination(query)
            const search = typeof query.q === "string" && query.q.length > 0 ? query.q : undefined
            if (getGiftSync(id) === null) return reply.status(404).send({ error: "礼包不存在" })
            return reply.status(200).send({
                ...listRedemptions(id, page, pageSize, search),
                page,
                pageSize,
            })
        } catch (error) {
            return sendRouteError(request, reply, error)
        }
    })
}

export default routes
