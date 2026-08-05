import { randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
const SCHEMA_VERSION = 1
const OWNER_TOKEN_PATTERN = /^[0-9a-f]{32}$/
export type MultiHubCredentialLockErrorCode = "MULTI_HUB_CREDENTIAL_LOCK_TIMEOUT"
    | "MULTI_HUB_CREDENTIAL_LOCK_UNSAFE"
    | "MULTI_HUB_CREDENTIAL_LOCK_REPLACED"
export class MultiHubCredentialLockError extends Error {
    constructor(readonly code: MultiHubCredentialLockErrorCode) {
        super(code); this.name = "MultiHubCredentialLockError"
    }
}
export interface MultiHubCredentialLock { readonly lockPath: string; release(): void }
export interface MultiHubCredentialLockOptions {
    readonly timeoutMs?: number; readonly pollIntervalMs?: number
    readonly staleMs?: number; readonly pid?: number
    readonly ownerToken?: string; readonly now?: () => number
    readonly sleep?: (milliseconds: number) => void; readonly isProcessAlive?: (pid: number) => boolean
}
interface FileIdentity { readonly dev: number; readonly ino: number }
interface LockRecord {
    readonly schemaVersion: 1; readonly ownerToken: string
    readonly pid: number; readonly createdAt: number
}
interface InspectedLock { readonly identity: FileIdentity; readonly record: LockRecord | null }
function isCode(error: unknown, code: string): boolean {
    return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === code)
}
function lockError(code: MultiHubCredentialLockErrorCode): never { throw new MultiHubCredentialLockError(code) }
function identity(stats: fs.Stats): FileIdentity { return { dev: stats.dev, ino: stats.ino } }
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean { return left.dev === right.dev && left.ino === right.ino }
function positive(value: number, name: string, allowZero = false): number {
    if (!Number.isFinite(value) || value < (allowZero ? 0 : 1)) throw new TypeError(
        `${name} must be ${allowZero ? "non-negative" : "positive"}`,
    )
    return value
}
function parseRecord(text: string): LockRecord {
    let value: unknown
    try { value = JSON.parse(text) } catch { return lockError("MULTI_HUB_CREDENTIAL_LOCK_UNSAFE") }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return lockError("MULTI_HUB_CREDENTIAL_LOCK_UNSAFE")
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join(",") !== "createdAt,ownerToken,pid,schemaVersion"
        || record.schemaVersion !== SCHEMA_VERSION
        || typeof record.ownerToken !== "string"
        || !OWNER_TOKEN_PATTERN.test(record.ownerToken)
        || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
        || !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0) {
        return lockError("MULTI_HUB_CREDENTIAL_LOCK_UNSAFE")
    }
    return record as unknown as LockRecord
}
function inspectLock(lockPath: string): InspectedLock {
    const before = fs.lstatSync(lockPath)
    if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o777) !== 0o600) {
        return lockError("MULTI_HUB_CREDENTIAL_LOCK_UNSAFE")
    }
    const descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | NOFOLLOW)
    try {
        const opened = fs.fstatSync(descriptor)
        if (!opened.isFile() || !sameIdentity(identity(before), identity(opened))) {
            return lockError("MULTI_HUB_CREDENTIAL_LOCK_UNSAFE")
        }
        let record: LockRecord | null = null
        try { record = parseRecord(fs.readFileSync(descriptor, "utf8")) } catch (error) {
            if (!(error instanceof MultiHubCredentialLockError)) throw error
        }
        return { identity: identity(opened), record }
    } finally {
        fs.closeSync(descriptor)
    }
}
function assertDirectory(directory: string, expected?: FileIdentity): FileIdentity {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const stats = fs.lstatSync(directory)
    if (stats.isSymbolicLink() || !stats.isDirectory()
        || (expected && !sameIdentity(expected, identity(stats)))) {
        return lockError("MULTI_HUB_CREDENTIAL_LOCK_UNSAFE")
    }
    return identity(stats)
}
function unlinkIdentity(lockPath: string, expected: FileIdentity): void {
    let stats: fs.Stats
    try { stats = fs.lstatSync(lockPath) } catch (error) {
        if (isCode(error, "ENOENT")) return lockError("MULTI_HUB_CREDENTIAL_LOCK_REPLACED")
        throw error
    }
    if (stats.isSymbolicLink() || !stats.isFile() || !sameIdentity(expected, identity(stats))) {
        return lockError("MULTI_HUB_CREDENTIAL_LOCK_REPLACED")
    }
    fs.unlinkSync(lockPath)
}
function unlinkOwned(lockPath: string, expectedIdentity: FileIdentity, ownerToken: string): void {
    let current: ReturnType<typeof inspectLock>
    try { current = inspectLock(lockPath) } catch (error) {
        if (isCode(error, "ENOENT")) return lockError("MULTI_HUB_CREDENTIAL_LOCK_REPLACED")
        throw error
    }
    if (!sameIdentity(current.identity, expectedIdentity)
        || current.record?.ownerToken !== ownerToken) {
        return lockError("MULTI_HUB_CREDENTIAL_LOCK_REPLACED")
    }
    unlinkIdentity(lockPath, expectedIdentity)
}
function defaultProcessAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (error) { return !isCode(error, "ESRCH") } }
function createCandidate(candidatePath: string, record: LockRecord): FileIdentity {
    let descriptor: number | null = null
    let created: FileIdentity | null = null
    try {
        descriptor = fs.openSync(candidatePath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600)
        created = identity(fs.fstatSync(descriptor))
        fs.writeFileSync(descriptor, JSON.stringify(record))
        fs.fsyncSync(descriptor)
        return created
    } catch (error) {
        if (created !== null) try { unlinkIdentity(candidatePath, created) } catch { /* original error wins */ }
        throw error
    } finally {
        if (descriptor !== null) fs.closeSync(descriptor)
    }
}
export function acquireMultiHubCredentialLock(
    credentialsPath: string, options: MultiHubCredentialLockOptions = {},
): MultiHubCredentialLock {
    if (!path.isAbsolute(credentialsPath)) throw new TypeError("credentialsPath must be absolute")
    const timeoutMs = positive(options.timeoutMs ?? 5_000, "timeoutMs", true)
    const pollIntervalMs = positive(options.pollIntervalMs ?? 25, "pollIntervalMs")
    const staleMs = positive(options.staleMs ?? 60_000, "staleMs")
    const pid = options.pid ?? process.pid
    const ownerToken = options.ownerToken ?? randomBytes(16).toString("hex")
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("pid must be positive")
    if (!OWNER_TOKEN_PATTERN.test(ownerToken)) throw new TypeError("ownerToken must be 32 lowercase hex characters")
    const now = options.now ?? Date.now
    const sleep = options.sleep ?? (milliseconds => Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds))
    const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive
    const directory = path.dirname(credentialsPath)
    const directoryIdentity = assertDirectory(directory)
    const lockPath = `${credentialsPath}.lock`
    const startedAt = now()
    const candidatePath = `${lockPath}.${pid}.${randomBytes(8).toString("hex")}.tmp`
    const candidateIdentity = createCandidate(candidatePath,
        { schemaVersion: SCHEMA_VERSION, ownerToken, pid, createdAt: startedAt })
    try {
        while (true) {
            assertDirectory(directory, directoryIdentity)
            let published = false
            try {
                fs.linkSync(candidatePath, lockPath)
                published = true
                const acquired = inspectLock(lockPath)
                if (!sameIdentity(acquired.identity, candidateIdentity)
                    || acquired.record?.ownerToken !== ownerToken) {
                    return lockError("MULTI_HUB_CREDENTIAL_LOCK_UNSAFE")
                }
                unlinkIdentity(candidatePath, candidateIdentity)
                let released = false
                return Object.freeze({
                    lockPath,
                    release(): void {
                        if (released) return
                        assertDirectory(directory, directoryIdentity)
                        unlinkOwned(lockPath, candidateIdentity, ownerToken)
                        released = true
                    },
                })
            } catch (error) {
                if (published) try { unlinkIdentity(lockPath, candidateIdentity) } catch { /* original error wins */ }
                if (!isCode(error, "EEXIST")) throw error
            }
            let existing: ReturnType<typeof inspectLock>
            try { existing = inspectLock(lockPath) } catch (error) {
                if (isCode(error, "ENOENT")) continue; throw error
            }
            if (existing.record !== null
                && Math.max(0, now() - existing.record.createdAt) >= staleMs
                && !isProcessAlive(existing.record.pid)) {
                unlinkOwned(lockPath, existing.identity, existing.record.ownerToken)
                continue
            }
            if (now() - startedAt >= timeoutMs) {
                if (existing.record === null) return lockError("MULTI_HUB_CREDENTIAL_LOCK_UNSAFE")
                return lockError("MULTI_HUB_CREDENTIAL_LOCK_TIMEOUT")
            }
            sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (now() - startedAt))))
        }
    } finally {
        try { unlinkIdentity(candidatePath, candidateIdentity) } catch (error) {
            if (!(error instanceof MultiHubCredentialLockError)
                || error.code !== "MULTI_HUB_CREDENTIAL_LOCK_REPLACED") throw error
        }
    }
}
export function withMultiHubCredentialLock<T>(credentialsPath: string, operation: () => T): T {
    const lock = acquireMultiHubCredentialLock(credentialsPath)
    try { return operation() } finally { lock.release() }
}
