import {
    createHash,
    randomBytes,
    timingSafeEqual,
} from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { withMultiHubCredentialLock } from "./credential-lock"
import { generateMultiHubToken, validateMultiHubToken } from "./token"

const SCHEMA_VERSION = 1 as const
const CREDENTIAL_ID_PATTERN = /^[0-9a-f]{32}$/
const TOKEN_DIGEST_PATTERN = /^[0-9a-f]{64}$/
const ROOT_KEYS = ["credentials", "schemaVersion"]
const CREDENTIAL_KEYS = [
    "createdAt",
    "credentialId",
    "label",
    "revokedAt",
    "tokenDigest",
]

export interface MultiHubCredentialRecord {
    readonly credentialId: string
    readonly label: string
    readonly tokenDigest: string
    readonly createdAt: string
    readonly revokedAt: string | null
}

export interface MultiHubCredentialTable {
    readonly schemaVersion: typeof SCHEMA_VERSION
    readonly credentials: readonly MultiHubCredentialRecord[]
}

export interface MultiHubCredential {
    readonly credentialId: string
    readonly label: string
    readonly createdAt: string
    readonly revokedAt: string | null
}

export interface IssuedMultiHubCredential extends MultiHubCredential {
    readonly token: string
}

export interface MultiHubCredentialStoreOptions {
    readonly credentialsPath: string
    readonly now?: () => Date
    readonly generateToken?: () => string
    readonly generateCredentialId?: () => string
    readonly replaceFile?: (temporaryPath: string, credentialsPath: string) => void
}

export class MultiHubCredentialStoreError extends Error {
    constructor(readonly code: string) {
        super(code)
        this.name = "MultiHubCredentialStoreError"
    }
}

function failInvalidTable(): never {
    throw new MultiHubCredentialStoreError("INVALID_MULTI_HUB_CREDENTIALS")
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(value).sort().join(",") === [...keys].sort().join(",")
}

function isCanonicalTimestamp(value: unknown): value is string {
    if (typeof value !== "string") return false
    const time = Date.parse(value)
    return Number.isFinite(time) && new Date(time).toISOString() === value
}

function isValidLabel(value: unknown): value is string {
    return typeof value === "string"
        && value.length > 0
        && value === value.trim()
        && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
}

function parseTable(value: unknown): MultiHubCredentialTable {
    if (!isRecord(value)
        || !hasExactKeys(value, ROOT_KEYS)
        || value.schemaVersion !== SCHEMA_VERSION
        || !Array.isArray(value.credentials)) {
        return failInvalidTable()
    }

    const credentialIds = new Set<string>()
    const tokenDigests = new Set<string>()
    const credentials: MultiHubCredentialRecord[] = []
    for (const candidate of value.credentials) {
        if (!isRecord(candidate)
            || !hasExactKeys(candidate, CREDENTIAL_KEYS)
            || typeof candidate.credentialId !== "string"
            || !CREDENTIAL_ID_PATTERN.test(candidate.credentialId)
            || !isValidLabel(candidate.label)
            || typeof candidate.tokenDigest !== "string"
            || !TOKEN_DIGEST_PATTERN.test(candidate.tokenDigest)
            || !isCanonicalTimestamp(candidate.createdAt)
            || (candidate.revokedAt !== null && !isCanonicalTimestamp(candidate.revokedAt))
            || (candidate.revokedAt !== null
                && Date.parse(candidate.revokedAt) < Date.parse(candidate.createdAt))
            || credentialIds.has(candidate.credentialId)
            || tokenDigests.has(candidate.tokenDigest)) {
            return failInvalidTable()
        }
        credentialIds.add(candidate.credentialId)
        tokenDigests.add(candidate.tokenDigest)
        credentials.push(Object.freeze({
            credentialId: candidate.credentialId,
            label: candidate.label,
            tokenDigest: candidate.tokenDigest,
            createdAt: candidate.createdAt,
            revokedAt: candidate.revokedAt,
        }))
    }
    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        credentials: Object.freeze(credentials),
    })
}

function publicCredential(credential: MultiHubCredentialRecord): MultiHubCredential {
    return Object.freeze({
        credentialId: credential.credentialId,
        label: credential.label,
        createdAt: credential.createdAt,
        revokedAt: credential.revokedAt,
    })
}

function tokenDigest(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex")
}

export function parseMultiHubCredentialTable(text: string): MultiHubCredentialTable {
    try {
        return parseTable(JSON.parse(text))
    } catch (error) {
        if (error instanceof MultiHubCredentialStoreError) throw error
        return failInvalidTable()
    }
}

export class MultiHubCredentialStore {
    private readonly credentialsPath: string
    private readonly now: () => Date
    private readonly generateToken: () => string
    private readonly generateCredentialId: () => string
    private readonly replaceFile: (temporaryPath: string, credentialsPath: string) => void

    constructor(options: MultiHubCredentialStoreOptions) {
        if (!path.isAbsolute(options.credentialsPath)) {
            throw new MultiHubCredentialStoreError("INVALID_MULTI_HUB_CREDENTIALS_PATH")
        }
        this.credentialsPath = options.credentialsPath
        this.now = options.now ?? (() => new Date())
        this.generateToken = options.generateToken ?? generateMultiHubToken
        this.generateCredentialId = options.generateCredentialId
            ?? (() => randomBytes(16).toString("hex"))
        this.replaceFile = options.replaceFile ?? fs.renameSync
    }

    create(label: string): IssuedMultiHubCredential {
        if (!isValidLabel(label)) {
            throw new MultiHubCredentialStoreError("INVALID_MULTI_HUB_CREDENTIAL_LABEL")
        }
        return withMultiHubCredentialLock(
            this.credentialsPath,
            () => this.createLocked(label),
        )
    }

    private createLocked(label: string): IssuedMultiHubCredential {
        const table = this.readTable()
        const token = this.generateToken()
        const credentialId = this.generateCredentialId()
        if (!validateMultiHubToken(token)
            || !CREDENTIAL_ID_PATTERN.test(credentialId)) {
            throw new MultiHubCredentialStoreError("INVALID_GENERATED_MULTI_HUB_CREDENTIAL")
        }
        const digest = tokenDigest(token)
        if (table.credentials.some(credential => credential.credentialId === credentialId)) {
            throw new MultiHubCredentialStoreError("DUPLICATE_MULTI_HUB_CREDENTIAL_ID")
        }
        if (table.credentials.some(credential => credential.tokenDigest === digest)) {
            throw new MultiHubCredentialStoreError("DUPLICATE_MULTI_HUB_TOKEN")
        }
        const createdAt = this.timestamp()
        const credential: MultiHubCredentialRecord = Object.freeze({
            credentialId,
            label,
            tokenDigest: digest,
            createdAt,
            revokedAt: null,
        })
        this.writeTable({
            schemaVersion: SCHEMA_VERSION,
            credentials: [...table.credentials, credential],
        })
        return Object.freeze({ ...publicCredential(credential), token })
    }

    list(): readonly MultiHubCredential[] {
        return Object.freeze(this.readTable().credentials.map(publicCredential))
    }

    revoke(credentialId: string): MultiHubCredential {
        if (!CREDENTIAL_ID_PATTERN.test(credentialId)) {
            throw new MultiHubCredentialStoreError("INVALID_MULTI_HUB_CREDENTIAL_ID")
        }
        return withMultiHubCredentialLock(
            this.credentialsPath,
            () => this.revokeLocked(credentialId),
        )
    }

    private revokeLocked(credentialId: string): MultiHubCredential {
        const table = this.readTable()
        const index = table.credentials.findIndex(item => item.credentialId === credentialId)
        if (index < 0) throw new MultiHubCredentialStoreError("MULTI_HUB_CREDENTIAL_NOT_FOUND")
        const current = table.credentials[index]
        if (current.revokedAt !== null) return publicCredential(current)

        const revokedAt = this.timestamp()
        if (Date.parse(revokedAt) < Date.parse(current.createdAt)) {
            throw new MultiHubCredentialStoreError("INVALID_MULTI_HUB_CREDENTIAL_TIME")
        }
        const revoked = Object.freeze({ ...current, revokedAt })
        const credentials = [...table.credentials]
        credentials[index] = revoked
        this.writeTable({ schemaVersion: SCHEMA_VERSION, credentials })
        return publicCredential(revoked)
    }

    authenticate(token: string): MultiHubCredential | null {
        if (!validateMultiHubToken(token)) return null
        const candidate = Buffer.from(tokenDigest(token), "hex")
        let match: MultiHubCredentialRecord | null = null
        for (const credential of this.readTable().credentials) {
            const digest = Buffer.from(credential.tokenDigest, "hex")
            if (credential.revokedAt === null && timingSafeEqual(candidate, digest)) {
                match = credential
            }
        }
        return match === null ? null : publicCredential(match)
    }

    private timestamp(): string {
        const date = this.now()
        if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
            throw new MultiHubCredentialStoreError("INVALID_MULTI_HUB_CREDENTIAL_TIME")
        }
        return date.toISOString()
    }

    private readTable(): MultiHubCredentialTable {
        let stats: fs.Stats
        try {
            stats = fs.lstatSync(this.credentialsPath)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return Object.freeze({ schemaVersion: SCHEMA_VERSION, credentials: Object.freeze([]) })
            }
            return failInvalidTable()
        }
        if (stats.isSymbolicLink() || !stats.isFile()) return failInvalidTable()
        try {
            return parseMultiHubCredentialTable(fs.readFileSync(this.credentialsPath, "utf8"))
        } catch (error) {
            if (error instanceof MultiHubCredentialStoreError) throw error
            return failInvalidTable()
        }
    }

    private writeTable(table: MultiHubCredentialTable): void {
        const directory = path.dirname(this.credentialsPath)
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
        const fileMode = this.currentFileMode()
        const temporaryPath = path.join(
            directory,
            `.${path.basename(this.credentialsPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
        )
        let descriptor: number | null = null
        try {
            descriptor = fs.openSync(temporaryPath, "wx", fileMode)
            fs.writeFileSync(descriptor, `${JSON.stringify(table, null, 2)}\n`, "utf8")
            fs.fchmodSync(descriptor, fileMode)
            fs.fsyncSync(descriptor)
            fs.closeSync(descriptor)
            descriptor = null
            this.replaceFile(temporaryPath, this.credentialsPath)
        } finally {
            if (descriptor !== null) fs.closeSync(descriptor)
            try {
                fs.unlinkSync(temporaryPath)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
        }
    }

    private currentFileMode(): number {
        try {
            const stats = fs.lstatSync(this.credentialsPath)
            if (stats.isSymbolicLink() || !stats.isFile()) return failInvalidTable()
            return stats.mode & 0o777
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0o600
            throw error
        }
    }
}
