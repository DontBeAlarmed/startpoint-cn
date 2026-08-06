import * as fs from "node:fs"
import { randomBytes } from "node:crypto"
import * as path from "node:path"

import {
    ServerTimePackage,
    ServerTimeState,
} from "./types"
import { prepareDataVolume } from "../data-paths"

const SERVER_TIME_KEYS = ["generatedAt", "mode", "offsetMs"] as const

export interface ServerTimeStoreOptions {
    readonly filePath?: string
    readonly legacyFilePath?: string
    readonly now?: () => number
    readonly replaceFile?: (temporaryPath: string, filePath: string) => void
}

export class ServerTimeStoreError extends Error {
    constructor(readonly code: "INVALID_SERVER_TIME_STATE", message: string = code) {
        super(message)
        this.name = "ServerTimeStoreError"
    }
}

function invalidState(message = "invalid server time state"): never {
    throw new ServerTimeStoreError("INVALID_SERVER_TIME_STATE", message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>): boolean {
    const actual = Object.keys(value).sort()
    const expected = [...SERVER_TIME_KEYS].sort()
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index])
}

function isCanonicalTimestamp(value: unknown): value is string {
    if (typeof value !== "string") return false
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function parseValue(value: unknown): ServerTimeState {
    if (!isRecord(value) || !hasExactKeys(value)) return invalidState()
    const mode = value.mode
    const offsetMs = value.offsetMs
    const generatedAt = value.generatedAt
    if ((mode !== "system" && mode !== "offset")
        || typeof offsetMs !== "number"
        || !Number.isSafeInteger(offsetMs)
        || !isCanonicalTimestamp(generatedAt)
        || (mode === "system" && offsetMs !== 0)) {
        return invalidState()
    }
    return Object.freeze({
        mode,
        offsetMs,
        generatedAt,
    })
}

export function parseServerTimePackage(text: string): ServerTimeState {
    try {
        return parseValue(JSON.parse(text))
    } catch (error) {
        if (error instanceof ServerTimeStoreError) throw error
        return invalidState()
    }
}

export function validateServerTimePackage(value: unknown): ServerTimePackage {
    return parseValue(value)
}

export class ServerTimeStore {
    private readonly filePath: string
    private readonly legacyFilePath: string | null
    private readonly now: () => number
    private readonly replaceFile: (temporaryPath: string, filePath: string) => void

    constructor(options: ServerTimeStoreOptions = {}) {
        const paths = options.filePath === undefined ? prepareDataVolume() : null
        this.filePath = options.filePath ?? path.join(paths!.dataDir, "server-time.json")
        if (!path.isAbsolute(this.filePath)) invalidState("server time path must be absolute")
        this.legacyFilePath = options.legacyFilePath === undefined
            ? paths?.activeAccountFile ?? null
            : options.legacyFilePath
        this.now = options.now ?? Date.now
        this.replaceFile = options.replaceFile ?? fs.renameSync
    }

    read(): ServerTimeState | null {
        let stats: fs.Stats
        try {
            stats = fs.lstatSync(this.filePath)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
            return invalidState()
        }
        if (stats.isSymbolicLink() || !stats.isFile()) return invalidState()
        try {
            return parseServerTimePackage(fs.readFileSync(this.filePath, "utf8"))
        } catch (error) {
            if (error instanceof ServerTimeStoreError) throw error
            return invalidState()
        }
    }

    readLegacyOffset(): number | null {
        if (this.legacyFilePath === null) return null
        let stats: fs.Stats
        try {
            stats = fs.lstatSync(this.legacyFilePath)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
            return null
        }
        if (stats.isSymbolicLink() || !stats.isFile()) return null
        try {
            const value = JSON.parse(fs.readFileSync(this.legacyFilePath, "utf8"))
            const offset = isRecord(value) ? value.timeOffset : null
            return typeof offset === "number" && Number.isSafeInteger(offset) ? offset : null
        } catch {
            return null
        }
    }

    write(value: ServerTimePackage): void {
        const state = validateServerTimePackage(value)
        const directory = path.dirname(this.filePath)
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

        let existing: fs.Stats | null = null
        try {
            existing = fs.lstatSync(this.filePath)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") return invalidState()
        }
        if (existing !== null && (existing.isSymbolicLink() || !existing.isFile())) {
            return invalidState()
        }

        const temporaryPath = path.join(
            directory,
            `.${path.basename(this.filePath)}.${process.pid}.${this.now()}.${randomBytes(8).toString("hex")}.tmp`,
        )
        let descriptor: number | null = null
        try {
            descriptor = fs.openSync(temporaryPath, "wx", 0o600)
            fs.writeFileSync(descriptor, `${JSON.stringify(state)}\n`, "utf8")
            fs.fchmodSync(descriptor, 0o600)
            fs.fsyncSync(descriptor)
            fs.closeSync(descriptor)
            descriptor = null
            this.replaceFile(temporaryPath, this.filePath)
        } finally {
            if (descriptor !== null) fs.closeSync(descriptor)
            try {
                fs.unlinkSync(temporaryPath)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
        }
    }
}
