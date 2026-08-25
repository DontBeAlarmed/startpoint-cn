import { getDb } from "../data/db"
import { getAccountSync, getAccountPlayersSync } from "../data/domains/account"
import { removeAccountFromAdminState } from "../data/activeAccount"
import { getRealNow } from "../runtime/time/game-time"

export type AccountCleanupPolicy = "retain" | "delete_after_timeout"
export type AccountCleanupState = "active" | "orphaned" | "deleted"

const DEFAULT_TIMEOUT_MS = 3 * 24 * 60 * 60 * 1000

export interface AccountCleanupSettings {
    readonly defaultPolicy: AccountCleanupPolicy
    readonly timeoutMs: number
    readonly updatedAt: Date
}

export interface AccountCleanupSummary {
    readonly accountId: number
    readonly adminNote: string | null
    readonly cleanupPolicy: AccountCleanupPolicy
    readonly cleanupDueAt: Date | null
    readonly cleanupState: AccountCleanupState
    readonly playerCount: number
    readonly deviceCount: number
}

function normalizePolicy(value: unknown): AccountCleanupPolicy {
    return value === "delete_after_timeout" ? "delete_after_timeout" : "retain"
}

function normalizeTimeout(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) return DEFAULT_TIMEOUT_MS
    return value as number
}

export function getAccountCleanupSettingsSync(): AccountCleanupSettings {
    const row = getDb().prepare(`
        SELECT default_policy, timeout_ms, updated_at
        FROM account_cleanup_settings
        WHERE id = 1
    `).get() as { default_policy: string; timeout_ms: number; updated_at: string } | undefined

    return {
        defaultPolicy: normalizePolicy(row?.default_policy),
        timeoutMs: normalizeTimeout(row?.timeout_ms),
        updatedAt: new Date(row?.updated_at ?? 0),
    }
}

export function updateAccountCleanupSettingsSync(
    defaultPolicy: AccountCleanupPolicy,
    timeoutMs: number,
    now: Date = getRealNow(),
): AccountCleanupSettings {
    const normalizedTimeout = normalizeTimeout(timeoutMs)
    getDb().prepare(`
        UPDATE account_cleanup_settings
        SET default_policy = ?, timeout_ms = ?, updated_at = ?
        WHERE id = 1
    `).run(normalizePolicy(defaultPolicy), normalizedTimeout, now.toISOString())
    return getAccountCleanupSettingsSync()
}

export function setAccountAdminNoteSync(
    accountId: number,
    note: string | null,
    now: Date = getRealNow(),
): boolean {
    const normalized = note === null ? null : note.trim()
    const value = normalized === "" ? null : normalized
    const result = getDb().prepare(`
        UPDATE accounts
        SET admin_note = ?, cleanup_due_at = CASE
            WHEN cleanup_policy = 'delete_after_timeout' AND ? IS NULL
            THEN ?
            ELSE cleanup_due_at
        END
        WHERE id = ?
    `).run(value, value, new Date(now.getTime() + getAccountCleanupSettingsSync().timeoutMs).toISOString(), accountId)
    return result.changes === 1
}

export function setAccountCleanupPolicySync(
    accountId: number,
    policy: AccountCleanupPolicy,
    now: Date = getRealNow(),
): boolean {
    const normalizedPolicy = normalizePolicy(policy)
    const settings = getAccountCleanupSettingsSync()
    const dueAt = normalizedPolicy === "delete_after_timeout"
        ? new Date(now.getTime() + settings.timeoutMs).toISOString()
        : null
    const result = getDb().prepare(`
        UPDATE accounts
        SET cleanup_policy = ?, cleanup_due_at = ?, cleanup_state = 'active'
        WHERE id = ?
    `).run(normalizedPolicy, dueAt, accountId)
    return result.changes === 1
}

export function markAccountOrphanedSync(accountId: number): boolean {
    const result = getDb().prepare(`
        UPDATE accounts
        SET cleanup_state = 'orphaned'
        WHERE id = ?
    `).run(accountId)
    return result.changes === 1
}

export function getAccountCleanupSummarySync(accountId: number): AccountCleanupSummary | null {
    const account = getAccountSync(accountId)
    if (!account) return null
    const db = getDb()
    const players = db.prepare(`SELECT COUNT(*) AS count FROM players WHERE account_id = ?`)
        .get(accountId) as { count: number }
    const devices = db.prepare(`SELECT COUNT(*) AS count FROM device_bindings WHERE account_id = ?`)
        .get(accountId) as { count: number }
    return {
        accountId,
        adminNote: account.adminNote ?? null,
        cleanupPolicy: account.cleanupPolicy ?? "retain",
        cleanupDueAt: account.cleanupDueAt ?? null,
        cleanupState: account.cleanupState ?? "active",
        playerCount: players.count,
        deviceCount: devices.count,
    }
}

export function listAccountCleanupSummariesSync(): AccountCleanupSummary[] {
    return getDb().prepare(`SELECT id FROM accounts ORDER BY id DESC`).all()
        .map(row => getAccountCleanupSummarySync((row as { id: number }).id))
        .filter((row): row is AccountCleanupSummary => row !== null)
}

/**
 * Deletes an account and all of its player domains in one transaction.
 * The caller is deliberately responsible for choosing the account and reason.
 */
export function deleteAccountForCleanupSync(
    accountId: number,
    reason: string,
    now: Date = getRealNow(),
): { accountId: number; playerIds: number[] } | null {
    const db = getDb()
    const playerIds = getAccountPlayersSync(accountId)
    const deleted = db.transaction(() => {
        const account = db.prepare(`SELECT id, cleanup_policy FROM accounts WHERE id = ?`).get(accountId) as {
            id: number
            cleanup_policy: string
        } | undefined
        if (!account) return false
        db.prepare(`
            INSERT INTO account_cleanup_audit (
                account_id, reason, cleanup_policy, player_count, deleted_at
            ) VALUES (?, ?, ?, ?, ?)
        `).run(accountId, reason, account.cleanup_policy, playerIds.length, now.toISOString())
        return db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId).changes === 1
    })()
    if (!deleted) return null
    removeAccountFromAdminState(accountId, playerIds)
    return { accountId, playerIds }
}

/** Runs one deterministic due-account sweep. */
export function runDueAccountCleanupSync(now: Date = getRealNow()): number {
    const dueAccounts = getDb().prepare(`
        SELECT id
        FROM accounts
        WHERE cleanup_policy = 'delete_after_timeout'
          AND cleanup_due_at IS NOT NULL
          AND cleanup_due_at <= ?
          AND (admin_note IS NULL OR TRIM(admin_note) = '')
        ORDER BY id
    `).all(now.toISOString()) as Array<{ id: number }>
    let deleted = 0
    for (const row of dueAccounts) {
        if (deleteAccountForCleanupSync(row.id, "automatic_timeout", now)) deleted++
    }
    return deleted
}

export class AccountCleanupService {
    private timer: NodeJS.Timeout | null = null

    start(intervalMs: number = 60_000): void {
        if (this.timer !== null) return
        runDueAccountCleanupSync()
        this.timer = setInterval(() => {
            try {
                runDueAccountCleanupSync()
            } catch (error) {
                console.error(`[ACCOUNT-CLEANUP] sweep failed: ${error instanceof Error ? error.message : String(error)}`)
            }
        }, intervalMs)
        this.timer.unref()
    }

    stop(): void {
        if (this.timer === null) return
        clearInterval(this.timer)
        this.timer = null
    }
}
