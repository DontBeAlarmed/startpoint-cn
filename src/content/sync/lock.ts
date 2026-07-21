import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

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

function sameIdentity(left: LockIdentity, right: LockIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino
}

function identityOf(stat: fs.Stats): LockIdentity {
    return { dev: stat.dev, ino: stat.ino }
}

function parseLockRecord(bytes: Buffer): LockRecord {
    let value: unknown
    try {
        value = JSON.parse(bytes.toString("utf8"))
    } catch {
        throw new ContentSyncLockError(
            "CONTENT_SYNC_LOCK_LEGACY",
            "sync.lock 不是当前锁格式；确认没有同步进程后请人工删除该文件",
        )
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ContentSyncLockError(
            "CONTENT_SYNC_LOCK_LEGACY",
            "sync.lock 不是当前锁格式；确认没有同步进程后请人工删除该文件",
        )
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    if (keys.join(",") !== "pid,schemaVersion,token"
        || record.schemaVersion !== LOCK_SCHEMA_VERSION
        || typeof record.token !== "string"
        || !TOKEN_PATTERN.test(record.token)
        || !Number.isSafeInteger(record.pid)
        || (record.pid as number) <= 0) {
        throw new ContentSyncLockError(
            "CONTENT_SYNC_LOCK_LEGACY",
            "sync.lock 不是当前锁格式；确认没有同步进程后请人工删除该文件",
        )
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

async function inspectExistingLock(lockPath: string): Promise<LockRecord> {
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
        return parseLockRecord(await handle.readFile())
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
        const record = await inspectExistingLock(lockPath)
        if (record.token !== expectedToken) {
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

    const now = options.now ?? Date.now
    const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
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

        let existing: LockRecord | null = null
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
        if (now() - startedAt >= timeoutMs) {
            if (legacyError) throw legacyError
            throw new ContentSyncLockError(
                "CONTENT_SYNC_LOCK_TIMEOUT",
                `等待同步锁超时（pid ${(existing as LockRecord).pid}）；若该进程已退出，请确认后人工删除 sync.lock`,
            )
        }
        await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (now() - startedAt))))
    }
}
