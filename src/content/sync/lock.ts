import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { getRealNowMs } from "../../runtime/time/game-time"

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0
const LOCK_SCHEMA_VERSION = 1
const TOKEN_PATTERN = /^[a-f0-9]{32}$/

export type ContentSyncLockErrorCode =
    | "CONTENT_SYNC_LOCK_TIMEOUT"
    | "CONTENT_SYNC_LOCK_LEGACY"
    | "CONTENT_SYNC_LOCK_UNSAFE"
    | "CONTENT_SYNC_LOCK_REPLACED"

export class ContentSyncLockError extends Error {
    readonly code: ContentSyncLockErrorCode

    constructor(code: ContentSyncLockErrorCode, message: string) {
        super(`${code}: ${message}`)
        this.name = "ContentSyncLockError"
        this.code = code
    }
}

export class ContentSyncLockCleanupError extends Error {
    readonly operationError: unknown
    readonly cleanupErrors: readonly unknown[]

    constructor(operationError: unknown, cleanupErrors: readonly unknown[]) {
        const operationMessage = operationError instanceof Error
            ? operationError.message
            : String(operationError)
        const cleanupMessage = cleanupErrors.map(error => (
            error instanceof Error ? error.message : String(error)
        )).join("; ")
        super(`content sync lock operation failed: ${operationMessage}; cleanup failed: ${cleanupMessage}`)
        this.name = "ContentSyncLockCleanupError"
        this.operationError = operationError
        this.cleanupErrors = Object.freeze([...cleanupErrors])
    }
}

export interface ContentSyncLock {
    readonly lockPath: string
    release(): Promise<void>
}

export interface AcquireContentSyncLockOptions {
    readonly timeoutMs?: number
    readonly pollIntervalMs?: number
    readonly pid?: number
    readonly token?: string
    readonly now?: () => number
    readonly sleep?: (milliseconds: number) => Promise<void>
    readonly writeLock?: (handle: fs.promises.FileHandle, bytes: Buffer) => Promise<void>
    /** stale 接管阈值：死 pid 且锁龄超过该值才接管（防 pid 立即复用窗口） */
    readonly staleThresholdMs?: number
    /** pid 存活探测（测试注入）；默认 process.kill(pid, 0)，仅 ESRCH 视为已死 */
    readonly isProcessAlive?: (pid: number) => boolean
}

interface LockIdentity {
    readonly dev: number
    readonly ino: number
}

interface LockRecord {
    readonly schemaVersion: 1
    readonly token: string
    readonly pid: number
}

function isCode(error: unknown, code: string): boolean {
    return Boolean(error && typeof error === "object"
        && (error as NodeJS.ErrnoException).code === code)
}

/**
 * pid 存活探测（credential-lock 同款）：仅 ESRCH 视为已死。
 * 误判方向（写进测试注释）：pid 被复用为无关进程时 ESRCH 不出现 → 不接管，
 * 不会误删活锁；接管失败回落到既有超时语义。
 */
function defaultProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return !isCode(error, "ESRCH")
    }
}

function sameIdentity(left: LockIdentity, right: LockIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino
}

function identityOf(stat: fs.Stats): LockIdentity {
    return { dev: stat.dev, ino: stat.ino }
}

/**
 * 解析锁记录；不合规返回 null（S2：空文件/垃圾内容在超时后可接管——
 * 本仓只有一种锁格式，"格式冲突的另一个同步进程"在全部部署形态下不存在）。
 * symlink/非普通文件仍由调用方 fail-closed 拒绝，不走本函数。
 */
function parseLockRecord(bytes: Buffer): LockRecord | null {
    let value: unknown
    try {
        value = JSON.parse(bytes.toString("utf8"))
    } catch {
        return null
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    if (keys.join(",") !== "pid,schemaVersion,token"
        || record.schemaVersion !== LOCK_SCHEMA_VERSION
        || typeof record.token !== "string"
        || !TOKEN_PATTERN.test(record.token)
        || !Number.isSafeInteger(record.pid)
        || (record.pid as number) <= 0) {
        return null
    }
    return record as unknown as LockRecord
}

async function assertSecureRoot(contentRootDir: string): Promise<LockIdentity> {
    await fs.promises.mkdir(contentRootDir, { recursive: true, mode: 0o700 })
    const before = await fs.promises.lstat(contentRootDir)
    if (before.isSymbolicLink() || !before.isDirectory()) {
        throw new ContentSyncLockError(
            "CONTENT_SYNC_LOCK_UNSAFE",
            "contentRootDir 必须是本机普通目录，不能是符号链接",
        )
    }
    const handle = await fs.promises.open(
        contentRootDir,
        fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW,
    )
    try {
        const opened = await handle.stat()
        if (!opened.isDirectory() || !sameIdentity(identityOf(before), identityOf(opened))) {
            throw new ContentSyncLockError(
                "CONTENT_SYNC_LOCK_UNSAFE",
                "contentRootDir 在打开期间发生变化",
            )
        }
        return identityOf(opened)
    } finally {
        await handle.close()
    }
}

async function assertRootIdentity(contentRootDir: string, expected: LockIdentity): Promise<void> {
    const stat = await fs.promises.lstat(contentRootDir)
    if (stat.isSymbolicLink() || !stat.isDirectory()
        || !sameIdentity(expected, identityOf(stat))) {
        throw new ContentSyncLockError(
            "CONTENT_SYNC_LOCK_UNSAFE",
            "contentRootDir 在锁存续期间被替换",
        )
    }
}

type ExistingLock =
    | { readonly kind: "record"; readonly record: LockRecord; readonly identity: LockIdentity; readonly mtimeMs: number }
    | { readonly kind: "empty" | "garbage"; readonly identity: LockIdentity; readonly mtimeMs: number }

async function inspectExistingLock(lockPath: string): Promise<ExistingLock> {
    const before = await fs.promises.lstat(lockPath)
    if (before.isSymbolicLink()) {
        throw new ContentSyncLockError(
            "CONTENT_SYNC_LOCK_UNSAFE",
            "sync.lock 不能是 symbolic link；确认没有同步进程后请人工删除",
        )
    }
    if (!before.isFile()) {
        throw new ContentSyncLockError(
            "CONTENT_SYNC_LOCK_LEGACY",
            "sync.lock 不是普通文件；确认没有同步进程后请人工删除",
        )
    }
    const handle = await fs.promises.open(lockPath, fs.constants.O_RDONLY | NOFOLLOW)
    try {
        const opened = await handle.stat()
        if (!opened.isFile() || !sameIdentity(identityOf(before), identityOf(opened))) {
            throw new ContentSyncLockError(
                "CONTENT_SYNC_LOCK_UNSAFE",
                "sync.lock 在读取期间发生变化",
            )
        }
        const bytes = await handle.readFile()
        const record = parseLockRecord(bytes)
        if (record !== null) {
            return { kind: "record", record, identity: identityOf(opened), mtimeMs: opened.mtimeMs }
        }
        return {
            kind: bytes.length === 0 ? "empty" : "garbage",
            identity: identityOf(opened),
            mtimeMs: opened.mtimeMs,
        }
    } finally {
        await handle.close()
    }
}

async function unlinkOwnedFile(
    lockPath: string,
    expected: LockIdentity,
    expectedToken: string | null,
): Promise<void> {
    let before: fs.Stats
    try {
        before = await fs.promises.lstat(lockPath)
    } catch (error) {
        if (isCode(error, "ENOENT") && expectedToken === null) return
        if (isCode(error, "ENOENT")) {
            throw new ContentSyncLockError(
                "CONTENT_SYNC_LOCK_REPLACED",
                "sync.lock 已消失，无法确认锁身份",
            )
        }
        throw error
    }
    if (before.isSymbolicLink() || !before.isFile()
        || !sameIdentity(expected, identityOf(before))) {
        throw new ContentSyncLockError(
            "CONTENT_SYNC_LOCK_REPLACED",
            "sync.lock identity 已被替换，拒绝删除",
        )
    }
    if (expectedToken !== null) {
        const current = await inspectExistingLock(lockPath)
        if (current.kind !== "record" || current.record.token !== expectedToken) {
            throw new ContentSyncLockError(
                "CONTENT_SYNC_LOCK_REPLACED",
                "sync.lock token 已被替换，拒绝删除",
            )
        }
        const after = await fs.promises.lstat(lockPath)
        if (!sameIdentity(expected, identityOf(after))) {
            throw new ContentSyncLockError(
                "CONTENT_SYNC_LOCK_REPLACED",
                "sync.lock identity 已被替换，拒绝删除",
            )
        }
    }
    await fs.promises.unlink(lockPath)
}

function positiveDuration(value: number, label: string, allowZero: boolean): number {
    if (!Number.isFinite(value) || value < (allowZero ? 0 : 1)) {
        throw new TypeError(`${label} must be ${allowZero ? "non-negative" : "positive"}`)
    }
    return value
}

export async function acquireContentSyncLock(
    contentRootDir: string,
    options: AcquireContentSyncLockOptions = {},
): Promise<ContentSyncLock> {
    if (!contentRootDir || !path.isAbsolute(contentRootDir)) {
        throw new TypeError("contentRootDir must be an absolute path")
    }
    const root = path.resolve(contentRootDir)
    const timeoutMs = positiveDuration(options.timeoutMs ?? 30_000, "timeoutMs", true)
    const pollIntervalMs = positiveDuration(
        options.pollIntervalMs ?? 50,
        "pollIntervalMs",
        false,
    )
    const pid = options.pid ?? process.pid
    const token = options.token ?? randomBytes(16).toString("hex")
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("pid must be a positive integer")
    if (!TOKEN_PATTERN.test(token)) throw new TypeError("token must be 32 lowercase hex characters")

    const now = options.now ?? getRealNowMs
    const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
    const staleThresholdMs = positiveDuration(options.staleThresholdMs ?? 60_000, "staleThresholdMs", true)
    const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive
    const writeLock = options.writeLock ?? (async (handle, bytes) => {
        await handle.writeFile(bytes)
    })
    const startedAt = now()
    const lockPath = path.join(root, "sync.lock")
    const rootIdentity = await assertSecureRoot(root)

    while (true) {
        await assertRootIdentity(root, rootIdentity)
        let handle: fs.promises.FileHandle | undefined
        let createdIdentity: LockIdentity | undefined
        try {
            handle = await fs.promises.open(
                lockPath,
                fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
                0o600,
            )
            createdIdentity = identityOf(await handle.stat())
            const bytes = Buffer.from(JSON.stringify({
                schemaVersion: LOCK_SCHEMA_VERSION,
                token,
                pid,
            }))
            await writeLock(handle, bytes)
            await handle.sync()
            await handle.close()
            handle = undefined
            await assertRootIdentity(root, rootIdentity)

            let released = false
            return Object.freeze({
                lockPath,
                async release(): Promise<void> {
                    if (released) return
                    await assertRootIdentity(root, rootIdentity)
                    await unlinkOwnedFile(lockPath, createdIdentity as LockIdentity, token)
                    released = true
                },
            })
        } catch (error) {
            const cleanupErrors: unknown[] = []
            if (handle) {
                try {
                    await handle.close()
                } catch (cleanupError) {
                    cleanupErrors.push(cleanupError)
                }
            }
            if (createdIdentity) {
                try {
                    await unlinkOwnedFile(lockPath, createdIdentity, null)
                } catch (cleanupError) {
                    cleanupErrors.push(cleanupError)
                }
            }
            if (cleanupErrors.length > 0) {
                throw new ContentSyncLockCleanupError(error, cleanupErrors)
            }
            if (!isCode(error, "EEXIST")) throw error
        }

        let existing: ExistingLock | null = null
        let legacyError: ContentSyncLockError | null = null
        try {
            existing = await inspectExistingLock(lockPath)
        } catch (error) {
            if (isCode(error, "ENOENT")) continue
            if (error instanceof ContentSyncLockError
                && error.code === "CONTENT_SYNC_LOCK_LEGACY") {
                legacyError = error
            } else {
                throw error
            }
        }
        // S1：持有者已死（ESRCH）且锁龄超过 stale 阈值 → 经 dev/ino 校验接管。
        // S2：空锁/垃圾锁（崩溃残留）同样要求锁龄超阈值——无年龄门槛会在双开
        // 场景把「败者 create→write 亚毫秒空窗的新锁」误判孤儿删除（双审需修项）。
        // 误判方向安全：pid 复用时 ESRCH 不出现 → 不接管，不会误删活锁。
        // 接管判定统一收口：expired 且满足接管条件才动手；未满足则继续睡眠
        //（总等待上界 = timeoutMs + staleThresholdMs），避免 30s 默认 < 60s 阈值
        // 导致死 pid 残留在首轮启动空转打不出接管窗口。
        const takeoverEligible = existing !== null
            && now() - existing.mtimeMs >= staleThresholdMs
            && (existing.kind !== "record"
                || !isProcessAlive(existing.record.pid))
        const expired = now() - startedAt >= timeoutMs
        if (expired && takeoverEligible && existing !== null) {
            try {
                await unlinkOwnedFile(lockPath, existing.identity, null)
                console.warn(`[CONTENT_SYNC] stale sync.lock taken over: kind=${existing.kind}` +
                    (existing.kind === "record" ? ` pid=${existing.record.pid}` : ""))
                continue
            } catch (takeoverError) {
                throw new ContentSyncLockError(
                    "CONTENT_SYNC_LOCK_TIMEOUT",
                    `等待同步锁超时，且 stale 接管失败：${takeoverError instanceof Error ? takeoverError.message : String(takeoverError)}`,
                )
            }
        }
        if (expired && legacyError !== null) throw legacyError
        if (now() - startedAt >= timeoutMs + staleThresholdMs) {
            throw new ContentSyncLockError(
                "CONTENT_SYNC_LOCK_TIMEOUT",
                `等待同步锁超时${existing?.kind === "record" ? `（pid ${existing.record.pid}）` : ""}；若该进程已退出，请确认后人工删除 sync.lock`,
            )
        }
        await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs + staleThresholdMs - (now() - startedAt))))
    }
}
