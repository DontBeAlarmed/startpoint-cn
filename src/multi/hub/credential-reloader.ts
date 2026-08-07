import { createHash, timingSafeEqual } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import {
    type MultiHubCredential,
    type MultiHubCredentialRecord,
    parseMultiHubCredentialTable,
} from "./credential-store"
import { validateMultiHubToken } from "./token"

export interface CredentialReloaderOptions {
    readonly credentialsPath: string
    readonly intervalMs?: number
    readonly readFile?: (filePath: string) => string
    readonly warn?: (message: string) => void
}

export type CredentialAuthenticationResult =
    | { readonly ok: true; readonly credential: MultiHubCredential }
    | { readonly ok: false; readonly reason: "malformed" | "unknown" }
    | { readonly ok: false; readonly reason: "revoked"; readonly credentialId: string }

interface CredentialSnapshot {
    readonly records: readonly MultiHubCredentialRecord[]
    readonly byId: ReadonlyMap<string, MultiHubCredentialRecord>
    readonly enabled: number
}

const EMPTY_SNAPSHOT: CredentialSnapshot = Object.freeze({
    records: Object.freeze([]),
    byId: new Map(),
    enabled: 0,
})

function publicCredential(record: MultiHubCredentialRecord): MultiHubCredential {
    return Object.freeze({
        credentialId: record.credentialId,
        label: record.label,
        createdAt: record.createdAt,
        revokedAt: record.revokedAt,
    })
}

function snapshot(records: readonly MultiHubCredentialRecord[]): CredentialSnapshot {
    const byId = new Map(records.map(record => [record.credentialId, record]))
    return Object.freeze({
        records: Object.freeze([...records]),
        byId,
        enabled: records.filter(record => record.revokedAt === null).length,
    })
}

export class CredentialReloader {
    private readonly credentialsPath: string
    private readonly intervalMs: number
    private readonly readFile: (filePath: string) => string
    private readonly warn: (message: string) => void
    private current: CredentialSnapshot = EMPTY_SNAPSHOT
    private hasValidSnapshot = false
    private observedFingerprint: string | null = null
    private timer: NodeJS.Timeout | null = null

    constructor(options: CredentialReloaderOptions) {
        if (!path.isAbsolute(options.credentialsPath)) {
            throw new TypeError("credentialsPath must be absolute")
        }
        const intervalMs = options.intervalMs ?? 1_000
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
            throw new TypeError("intervalMs must be a positive safe integer")
        }
        this.credentialsPath = options.credentialsPath
        this.intervalMs = intervalMs
        this.readFile = options.readFile ?? (filePath => fs.readFileSync(filePath, "utf8"))
        this.warn = options.warn ?? (message => console.warn(`[MULTI HUB] ${message}`))
    }

    start(): void {
        if (this.timer !== null) return
        this.reloadIfChanged()
        this.timer = setInterval(() => this.reloadIfChanged(), this.intervalMs)
        this.timer.unref()
    }

    stop(): void {
        if (this.timer === null) return
        clearInterval(this.timer)
        this.timer = null
    }

    reloadIfChanged(): boolean {
        const metadata = this.metadata()
        if (metadata.fingerprint === this.observedFingerprint) return false
        this.observedFingerprint = metadata.fingerprint
        if (!metadata.exists) {
            if (this.hasValidSnapshot) {
                this.warn("credential reload rejected: INVALID_MULTI_HUB_CREDENTIALS")
            }
            return false
        }
        if (!metadata.validFile) {
            this.warn("credential reload rejected: INVALID_MULTI_HUB_CREDENTIALS")
            return false
        }
        try {
            const table = parseMultiHubCredentialTable(this.readFile(this.credentialsPath))
            this.current = snapshot(table.credentials)
            this.hasValidSnapshot = true
            return true
        } catch {
            this.warn("credential reload rejected: INVALID_MULTI_HUB_CREDENTIALS")
            return false
        }
    }

    authenticateDetailed(token: string | null): CredentialAuthenticationResult {
        if (!validateMultiHubToken(token)) return { ok: false, reason: "malformed" }
        const candidate = createHash("sha256").update(token, "utf8").digest()
        let activeMatch: MultiHubCredentialRecord | null = null
        let revokedMatch: MultiHubCredentialRecord | null = null
        for (const record of this.current.records) {
            const digest = Buffer.from(record.tokenDigest, "hex")
            if (timingSafeEqual(candidate, digest)) {
                if (record.revokedAt === null) activeMatch = record
                else revokedMatch = record
            }
        }
        if (activeMatch !== null) {
            return { ok: true, credential: publicCredential(activeMatch) }
        }
        if (revokedMatch !== null) {
            return {
                ok: false,
                reason: "revoked",
                credentialId: revokedMatch.credentialId,
            }
        }
        return { ok: false, reason: "unknown" }
    }

    authenticate(token: string): MultiHubCredential | null {
        const result = this.authenticateDetailed(token)
        return result.ok ? result.credential : null
    }

    isCredentialEnabled(credentialId: string): boolean {
        return this.current.byId.get(credentialId)?.revokedAt === null
    }

    getStatus(): { readonly total: number; readonly enabled: number } {
        return Object.freeze({
            total: this.current.records.length,
            enabled: this.current.enabled,
        })
    }

    private metadata(): { fingerprint: string; exists: boolean; validFile: boolean } {
        try {
            const stats = fs.lstatSync(this.credentialsPath)
            return {
                fingerprint: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`,
                exists: true,
                validFile: stats.isFile() && !stats.isSymbolicLink(),
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return { fingerprint: "missing", exists: false, validFile: false }
            }
            return { fingerprint: "unreadable", exists: true, validFile: false }
        }
    }
}
