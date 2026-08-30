import { getDb } from "../db"
import { parseTimezoneAwareCalendarTimestamp } from "../../lib/news-time"
import { validateNewsRichText } from "../../lib/news-rich-text"
import { getRealNow } from "../../runtime/time/game-time"

export type NewsCategory = 1 | 2 | 3

export interface ServerNewsRow {
    readonly id: number
    readonly category: NewsCategory
    readonly title: string
    readonly publishedAtReal: string
    readonly bodyRichText: string
    readonly label: number
    readonly thumbnail: number
    readonly enabled: boolean
    readonly revision: number
    readonly createdAt: string
    readonly updatedAt: string
}

export interface ValidatedNewsDraft {
    readonly category: NewsCategory
    readonly title: string
    readonly publishedAtReal: string
    readonly bodyRichText: string
    readonly label: number
    readonly thumbnail: number
    readonly enabled: boolean
}

export class NewsNotFoundError extends Error {
    constructor() {
        super("News not found")
        this.name = "NewsNotFoundError"
    }
}

export class NewsRevisionConflictError extends Error {
    constructor() {
        super("News revision conflict")
        this.name = "NewsRevisionConflictError"
    }
}

const NEWS_DRAFT_KEYS = [
    "bodyRichText",
    "category",
    "enabled",
    "label",
    "publishedAtReal",
    "thumbnail",
    "title",
] as const

function requireObject(input: unknown): Record<string, unknown> {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("News draft must be an object")
    }
    const record = input as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const expected = [...NEWS_DRAFT_KEYS].sort()
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
        throw new TypeError("News draft contains missing or unknown fields")
    }
    return record
}

function requireInteger(
    value: unknown,
    label: string,
    minimum: number,
    maximum: number,
): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)
        || value < minimum || value > maximum) {
        throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`)
    }
    return value
}

function requireTimestampWithTimezone(value: unknown, label: string): string {
    if (typeof value !== "string") {
        throw new TypeError(`${label} must include a timezone offset`)
    }
    const timestamp = parseTimezoneAwareCalendarTimestamp(value)
    if (!Number.isFinite(timestamp)) {
        throw new TypeError(`${label} must be a valid date and time`)
    }
    return new Date(timestamp).toISOString()
}

function requireUtcTimestamp(value: unknown, label: string): string {
    if (typeof value !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
        || !Number.isFinite(parseTimezoneAwareCalendarTimestamp(value))) {
        throw new TypeError(`${label} must be a UTC ISO timestamp`)
    }
    return value
}

function requireCategory(value: unknown): NewsCategory {
    if (value !== 1 && value !== 2 && value !== 3) {
        throw new TypeError("News category must be 1, 2, or 3")
    }
    return value
}

function validateDraftRecord(input: unknown): ValidatedNewsDraft {
    const record = requireObject(input)
    const title = record.title
    if (typeof title !== "string" || title.length < 1 || title.length > 128) {
        throw new TypeError("News title must be a string of 1 through 128 UTF-16 units")
    }
    if (typeof record.enabled !== "boolean") {
        throw new TypeError("News enabled must be a boolean")
    }
    const bodyRichText = record.bodyRichText
    if (typeof bodyRichText !== "string") {
        throw new TypeError("News RichText must be a string")
    }

    return {
        category: requireCategory(record.category),
        title,
        publishedAtReal: requireTimestampWithTimezone(
            record.publishedAtReal,
            "News publication time",
        ),
        bodyRichText: validateNewsRichText(bodyRichText),
        label: requireInteger(record.label, "News label", 1, 8),
        thumbnail: requireInteger(record.thumbnail, "News thumbnail", 1, 13),
        enabled: record.enabled,
    }
}

export function validateNewsDraft(input: unknown): ValidatedNewsDraft {
    return validateDraftRecord(input)
}

function rowToNews(row: Record<string, unknown>): ServerNewsRow {
    return {
        id: row.id as number,
        category: row.category as NewsCategory,
        title: row.title as string,
        publishedAtReal: row.published_at_real as string,
        bodyRichText: row.body_rich_text as string,
        label: row.label as number,
        thumbnail: row.thumbnail as number,
        enabled: row.enabled === 1,
        revision: row.revision as number,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
    }
}

function requireNewsId(id: number): number {
    return requireInteger(id, "News ID", 1, Number.MAX_SAFE_INTEGER)
}

function requireRevision(revision: number): number {
    return requireInteger(revision, "News revision", 1, Number.MAX_SAFE_INTEGER)
}

function requirePagination(
    page: number,
    pageSize: number,
    maximumPageSize = Number.MAX_SAFE_INTEGER,
): { limit: number; offset: number } {
    requireInteger(page, "News page", 1, Number.MAX_SAFE_INTEGER)
    requireInteger(pageSize, "News page size", 1, maximumPageSize)
    return { limit: pageSize, offset: (page - 1) * pageSize }
}

function getAdminRow(id: number): ServerNewsRow | null {
    const row = getDb().prepare("SELECT * FROM server_news WHERE id = ?").get(id)
    return row === undefined ? null : rowToNews(row as Record<string, unknown>)
}

function requireExistingNews(id: number): ServerNewsRow {
    const news = getAdminRow(id)
    if (news === null) throw new NewsNotFoundError()
    return news
}

export function listVisibleNewsSync(input: {
    category: NewsCategory
    nowIso: string
    page: number
    pageSize: 20
}): { rows: readonly ServerNewsRow[]; totalCount: number } {
    const category = requireCategory(input.category)
    const nowIso = requireUtcTimestamp(input.nowIso, "News current time")
    const pagination = requirePagination(input.page, input.pageSize, 20)
    const database = getDb()
    const rows = database.prepare(`
        SELECT * FROM server_news
        WHERE enabled = 1 AND category = ? AND published_at_real <= ?
        ORDER BY published_at_real DESC, id DESC
        LIMIT ? OFFSET ?
    `).all(category, nowIso, pagination.limit, pagination.offset)
        .map(row => rowToNews(row as Record<string, unknown>))
    const countRow = database.prepare(`
        SELECT COUNT(*) AS count FROM server_news
        WHERE enabled = 1 AND category = ? AND published_at_real <= ?
    `).get(category, nowIso) as { count: number }
    return { rows, totalCount: countRow.count }
}

export function getVisibleNewsSync(id: number, nowIso: string): ServerNewsRow | null {
    requireNewsId(id)
    const nowIsoValue = requireUtcTimestamp(nowIso, "News current time")
    const row = getDb().prepare(`
        SELECT * FROM server_news
        WHERE id = ? AND enabled = 1 AND published_at_real <= ?
    `).get(id, nowIsoValue)
    return row === undefined ? null : rowToNews(row as Record<string, unknown>)
}

export function listAdminNewsSync(
    page: number,
    pageSize: number,
): { rows: readonly ServerNewsRow[]; totalCount: number } {
    const pagination = requirePagination(page, pageSize)
    const database = getDb()
    const rows = database.prepare(`
        SELECT * FROM server_news
        ORDER BY published_at_real DESC, id DESC
        LIMIT ? OFFSET ?
    `).all(pagination.limit, pagination.offset)
        .map(row => rowToNews(row as Record<string, unknown>))
    const countResult = database.prepare(
        "SELECT COUNT(*) AS count FROM server_news",
    ).get() as { count: number }
    return { rows, totalCount: countResult.count }
}

export function getAdminNewsSync(id: number): ServerNewsRow | null {
    return getAdminRow(requireNewsId(id))
}

export function createNewsSync(input: ValidatedNewsDraft): ServerNewsRow {
    const draft = validateDraftRecord(input)
    const timestamp = getRealNow().toISOString()
    const result = getDb().prepare(`
        INSERT INTO server_news (
            category, title, published_at_real, body_rich_text, label,
            thumbnail, enabled, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
        draft.category,
        draft.title,
        draft.publishedAtReal,
        draft.bodyRichText,
        draft.label,
        draft.thumbnail,
        draft.enabled ? 1 : 0,
        timestamp,
        timestamp,
    )
    return requireExistingNews(Number(result.lastInsertRowid))
}

export function updateNewsSync(
    id: number,
    revision: number,
    input: ValidatedNewsDraft,
): ServerNewsRow {
    const newsId = requireNewsId(id)
    const currentRevision = requireRevision(revision)
    const draft = validateDraftRecord(input)
    const result = getDb().prepare(`
        UPDATE server_news
        SET category = ?,
            title = ?,
            published_at_real = ?,
            body_rich_text = ?,
            label = ?,
            thumbnail = ?,
            enabled = ?,
            revision = revision + 1,
            updated_at = ?
        WHERE id = ? AND revision = ?
    `).run(
        draft.category,
        draft.title,
        draft.publishedAtReal,
        draft.bodyRichText,
        draft.label,
        draft.thumbnail,
        draft.enabled ? 1 : 0,
        getRealNow().toISOString(),
        newsId,
        currentRevision,
    )
    if (result.changes !== 1) {
        if (getAdminRow(newsId) === null) throw new NewsNotFoundError()
        throw new NewsRevisionConflictError()
    }
    return requireExistingNews(newsId)
}

export function setNewsEnabledSync(
    id: number,
    revision: number,
    enabled: boolean,
): ServerNewsRow {
    if (typeof enabled !== "boolean") {
        throw new TypeError("News enabled must be a boolean")
    }
    const newsId = requireNewsId(id)
    const currentRevision = requireRevision(revision)
    const result = getDb().prepare(`
        UPDATE server_news
        SET enabled = ?,
            revision = revision + 1,
            updated_at = ?
        WHERE id = ? AND revision = ?
    `).run(
        enabled ? 1 : 0,
        getRealNow().toISOString(),
        newsId,
        currentRevision,
    )
    if (result.changes !== 1) {
        if (getAdminRow(newsId) === null) throw new NewsNotFoundError()
        throw new NewsRevisionConflictError()
    }
    return requireExistingNews(newsId)
}

export function deleteNewsSync(id: number, revision: number): void {
    const newsId = requireNewsId(id)
    const currentRevision = requireRevision(revision)
    const result = getDb().prepare(
        "DELETE FROM server_news WHERE id = ? AND revision = ?",
    ).run(newsId, currentRevision)
    if (result.changes !== 1) {
        if (getAdminRow(newsId) === null) throw new NewsNotFoundError()
        throw new NewsRevisionConflictError()
    }
}

function deliveryKey(newsId: number): string {
    if (!Number.isSafeInteger(newsId) || newsId <= 0) {
        throw new TypeError("newsId must be a positive safe integer")
    }
    return `server.forced_news.${newsId}`
}

export function hasForcedNewsDeliverySync(playerId: number, newsId: number): boolean {
    const row = getDb().prepare(`
        SELECT 1
        FROM players_options
        WHERE player_id = ? AND key = ?
        LIMIT 1
    `).get(playerId, deliveryKey(newsId))
    return row !== undefined
}

export function claimForcedNewsDeliverySync(
    playerId: number,
    newsId: number,
): boolean {
    const result = getDb().prepare(`
        INSERT OR IGNORE INTO players_options (key, value, player_id)
        VALUES (?, 1, ?)
    `).run(deliveryKey(newsId), playerId)
    return result.changes === 1
}
