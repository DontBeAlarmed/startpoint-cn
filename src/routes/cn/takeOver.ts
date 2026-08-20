import bcrypt from "bcryptjs"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { getDb } from "../../data/db"
import { getAccountPlayersSync } from "../../data/domains/account"
import { getPlayerCharacterSync } from "../../data/domains/character"
import { getPlayerSync } from "../../data/domains/player"
import { getSessionSync } from "../../data/domains/session"
import { removeAccountFromAdminState } from "../../data/activeAccount"
import { SessionType } from "../../data/types"
import { markAccountOrphanedSync } from "../../lib/account-cleanup"
import { getRankDegree } from "../../lib/stamina"
import { getRequestUdid } from "../../lib/takeover-access"
import { generateDataHeaders } from "../../utils"

const TAKEOVER_INPUT_ID_ERROR = 3203
const TAKEOVER_INPUT_ID_OR_PASSWORD_ERROR = 3204
const SOCIAL_ACCOUNT_NOT_FOUND = 3205

interface ViewerBody { viewer_id?: unknown }
interface PasswordBody extends ViewerBody { input_password?: unknown }
interface LookupBody extends PasswordBody { input_viewer_id?: unknown }
interface TransferBody extends LookupBody { device_id?: unknown }

interface ViewerAccountRow {
    account_id: number
    viewer_id: string
    admin_note: string | null
    takeover_password_hash: string | null
    takeover_udid: string | null
}

function send(reply: FastifyReply, data: unknown, viewerId = 0, resultCode = 1) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        data_headers: generateDataHeaders({ viewer_id: viewerId, result_code: resultCode }),
        data,
    })
}

function parseViewerId(value: unknown): string | null {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value)
    if (typeof value !== "string") return null
    const normalized = value.trim()
    return /^\d{6,15}$/.test(normalized) ? normalized : null
}

function parseDeviceId(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function isValidPassword(value: unknown): value is string {
    return typeof value === "string"
        && value.length >= 8
        && value.length <= 64
        && /^[A-Za-z0-9]+$/.test(value)
        && /[A-Z]/.test(value)
        && /[a-z]/.test(value)
        && /[0-9]/.test(value)
}

function accountByViewerId(viewerId: string): ViewerAccountRow | null {
    const row = getDb().prepare(`
        SELECT a.id AS account_id, s.token AS viewer_id,
               a.admin_note, a.takeover_password_hash, a.takeover_udid
        FROM sessions AS s
        JOIN accounts AS a ON a.id = s.account_id
        WHERE s.token = ? AND s.type = ? AND a.status = 'normal'
        LIMIT 1
    `).get(viewerId, SessionType.VIEWER) as ViewerAccountRow | undefined
    return row ?? null
}

function verifyPassword(account: ViewerAccountRow, password: unknown): boolean {
    return typeof password === "string"
        && account.takeover_password_hash !== null
        && bcrypt.compareSync(password, account.takeover_password_hash)
}

function buildUserData(viewerId: string) {
    const account = accountByViewerId(viewerId)
    if (!account) return null
    const playerId = getAccountPlayersSync(account.account_id)[0]
    if (!playerId) return null
    const player = getPlayerSync(playerId)
    if (!player) return null
    const leader = player.leaderCharacterId > 0
        ? getPlayerCharacterSync(playerId, player.leaderCharacterId)
        : null
    return {
        leader_character_evolution_img_level: leader?.evolutionLevel ?? 0,
        leader_character_id: player.leaderCharacterId,
        name: player.name,
        rank: getRankDegree(player.rankPoint || 0),
        viewer_id: Number(viewerId),
    }
}

function currentUserData(value: unknown) {
    const viewerId = parseViewerId(value)
    return viewerId ? buildUserData(viewerId) : null
}

function getSourceAccountId(currentViewerId: string | null, deviceId: number): number | null {
    const session = currentViewerId ? getSessionSync(currentViewerId) : null
    const binding = getDb().prepare(`
        SELECT account_id FROM device_bindings WHERE device_id = ?
    `).get(deviceId) as { account_id: number } | undefined
    if (session && session.type !== SessionType.VIEWER) return null
    if (session && binding && session.accountId !== binding.account_id) return null
    return session?.accountId ?? binding?.account_id ?? null
}

function transferAccount(
    target: ViewerAccountRow,
    password: string,
    currentViewerId: string | null,
    deviceId: number,
    udid: string,
): { sourceAccountId: number | null; sourcePlayerIds: number[]; sourceDeleted: boolean; sourceViewerId: number } {
    const db = getDb()
    const result = db.transaction(() => {
        const lockedTarget = accountByViewerId(target.viewer_id)
        if (!lockedTarget
            || lockedTarget.account_id !== target.account_id
            || !verifyPassword(lockedTarget, password)) {
            throw new Error("TAKEOVER_TARGET_CHANGED")
        }

        const sourceAccountId = getSourceAccountId(currentViewerId, deviceId)
        const sourceViewer = sourceAccountId === null ? null : db.prepare(`
            SELECT token FROM sessions WHERE account_id = ? AND type = ? LIMIT 1
        `).get(sourceAccountId, SessionType.VIEWER) as { token: string } | undefined
        const sourcePlayerIds = sourceAccountId === null ? [] : getAccountPlayersSync(sourceAccountId)
        const sourceAccount = sourceAccountId === null ? null : db.prepare(`
            SELECT admin_note FROM accounts WHERE id = ?
        `).get(sourceAccountId) as { admin_note: string | null } | undefined
        const hasSource = sourceAccountId !== null && sourceAccountId !== target.account_id
        const sourceIsMarked = Boolean(sourceAccount?.admin_note?.trim())

        db.prepare(`DELETE FROM device_bindings WHERE account_id = ? OR device_id = ?`)
            .run(target.account_id, deviceId)
        db.prepare(`DELETE FROM sessions WHERE account_id = ? AND type <> ?`)
            .run(target.account_id, SessionType.VIEWER)

        if (hasSource) {
            db.prepare(`DELETE FROM device_bindings WHERE account_id = ?`).run(sourceAccountId)
            db.prepare(`DELETE FROM sessions WHERE account_id = ?`).run(sourceAccountId)
            if (sourceIsMarked) {
                markAccountOrphanedSync(sourceAccountId)
            } else {
                db.prepare(`
                    INSERT INTO account_cleanup_audit (
                        account_id, reason, cleanup_policy, player_count, deleted_at
                    )
                    SELECT id, 'takeover_unmarked_source', cleanup_policy, ?, ?
                    FROM accounts WHERE id = ?
                `).run(sourcePlayerIds.length, new Date().toISOString(), sourceAccountId)
                db.prepare(`DELETE FROM accounts WHERE id = ?`).run(sourceAccountId)
            }
        }

        db.prepare(`
            INSERT INTO device_bindings (device_id, account_id, last_seen, name)
            VALUES (?, ?, ?, NULL)
        `).run(deviceId, target.account_id, new Date().toISOString())
        db.prepare(`
            UPDATE accounts
            SET takeover_udid = ?, last_login_time = ?
            WHERE id = ?
        `).run(udid, new Date().toISOString(), target.account_id)
        db.prepare(`
            INSERT INTO account_transfer_audit (
                source_account_id, source_viewer_id, target_account_id,
                target_viewer_id, source_player_count, source_deleted, transferred_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            hasSource ? sourceAccountId : null,
            hasSource && sourceViewer ? sourceViewer.token : null,
            target.account_id,
            target.viewer_id,
            sourcePlayerIds.length,
            hasSource && !sourceIsMarked ? 1 : 0,
            new Date().toISOString(),
        )

        return {
            sourceAccountId: hasSource ? sourceAccountId : null,
            sourcePlayerIds,
            sourceDeleted: hasSource && !sourceIsMarked,
            sourceViewerId: hasSource && sourceViewer ? Number(sourceViewer.token) : 0,
        }
    })()

    if (result.sourceDeleted && result.sourceAccountId !== null) {
        removeAccountFromAdminState(result.sourceAccountId, result.sourcePlayerIds)
    }
    return result
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/take_over_register/get_take_over_setting", async (request, reply) => {
        const body = (request.body ?? {}) as ViewerBody
        const viewerId = parseViewerId(body.viewer_id)
        const account = viewerId ? accountByViewerId(viewerId) : null
        if (!viewerId || !account) return send(reply, {}, 0, TAKEOVER_INPUT_ID_ERROR)
        return send(reply, {
            exists_user_take_over_data: Boolean(account.takeover_password_hash),
            social_account: {
                is_apple_linked: false,
                is_facebook_linked: false,
                is_google_linked: false,
            },
        }, Number(viewerId))
    })

    fastify.post("/take_over_register/register_take_over_data", async (request, reply) => {
        const body = (request.body ?? {}) as PasswordBody
        const viewerId = parseViewerId(body.viewer_id)
        const password = body.input_password
        const udid = getRequestUdid(request)
        const account = viewerId ? accountByViewerId(viewerId) : null
        if (!viewerId || !account || !udid) return send(reply, {}, 0, TAKEOVER_INPUT_ID_ERROR)
        if (!isValidPassword(password)) {
            return send(reply, {}, Number(viewerId), TAKEOVER_INPUT_ID_OR_PASSWORD_ERROR)
        }
        const hash = bcrypt.hashSync(password, 10)
        getDb().prepare(`
            UPDATE accounts SET takeover_password_hash = ?, takeover_udid = ? WHERE id = ?
        `).run(hash, udid, account.account_id)
        return send(reply, { registered_viewer_id: Number(viewerId) }, Number(viewerId))
    })

    fastify.post("/take_over/get_user_data_by_take_over_data", async (request, reply) => {
        const body = (request.body ?? {}) as LookupBody
        const inputViewerId = parseViewerId(body.input_viewer_id)
        const target = inputViewerId ? accountByViewerId(inputViewerId) : null
        if (!inputViewerId || !target || !verifyPassword(target, body.input_password)) {
            return send(reply, {}, inputViewerId ? Number(inputViewerId) : 0, inputViewerId ? TAKEOVER_INPUT_ID_OR_PASSWORD_ERROR : TAKEOVER_INPUT_ID_ERROR)
        }
        return send(reply, {
            current_user: currentUserData(body.viewer_id),
            linked_user: buildUserData(inputViewerId),
        }, Number(inputViewerId))
    })

    fastify.post("/take_over/take_over_by_take_over_data", async (request, reply) => {
        const body = (request.body ?? {}) as TransferBody
        const inputViewerId = parseViewerId(body.input_viewer_id)
        const currentViewerId = parseViewerId(body.viewer_id)
        const password = typeof body.input_password === "string" ? body.input_password : ""
        const deviceId = parseDeviceId(body.device_id)
        const udid = getRequestUdid(request)
        const target = inputViewerId ? accountByViewerId(inputViewerId) : null
        if (!inputViewerId || !target || !deviceId || !udid || !verifyPassword(target, password)) {
            return send(reply, {}, inputViewerId ? Number(inputViewerId) : 0, inputViewerId ? TAKEOVER_INPUT_ID_OR_PASSWORD_ERROR : TAKEOVER_INPUT_ID_ERROR)
        }
        try {
            const result = transferAccount(target, password, currentViewerId, deviceId, udid)
            return send(reply, {
                abolished_viewer_id: result.sourceDeleted ? result.sourceViewerId : 0,
                linked_viewer_id: Number(inputViewerId),
                short_udid: 0,
            }, Number(inputViewerId))
        } catch (error) {
            request.log.warn({ error }, "account takeover transaction rejected")
            return send(reply, {}, Number(inputViewerId), TAKEOVER_INPUT_ID_OR_PASSWORD_ERROR)
        }
    })

    fastify.post("/take_over/get_user_data_by_social_account", async (_request, reply) => send(reply, {}, 0, SOCIAL_ACCOUNT_NOT_FOUND))
    fastify.post("/take_over/take_over_by_social_account", async (_request, reply) => send(reply, {}, 0, SOCIAL_ACCOUNT_NOT_FOUND))
    fastify.post("/take_over_register/register_social_account", async (_request, reply) => send(reply, {}, 0, SOCIAL_ACCOUNT_NOT_FOUND))
    fastify.post("/take_over_register/disable_social_account", async (_request, reply) => send(reply, {}, 0, SOCIAL_ACCOUNT_NOT_FOUND))
}

export default routes
