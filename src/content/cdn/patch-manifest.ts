import path from "node:path"

import { deepFreeze } from "../deep-freeze"

export type PatchManifestErrorCode =
    | "PATCH_MANIFEST_SCHEMA"
    | "PATCH_CLIENT_INCOMPATIBLE"
    | "PATCH_BASE_VERSION_INVALID"
    | "PATCH_TARGET_VERSION_INVALID"
    | "PATCH_ARCHIVES_INVALID"
    | "PATCH_ARCHIVE_PATH_INVALID"
    | "PATCH_ARCHIVE_LAYER_INVALID"
    | "PATCH_ARCHIVE_ORDER_INVALID"
    | "PATCH_ARCHIVE_SIZE_INVALID"
    | "PATCH_ARCHIVE_SHA256_INVALID"

export class PatchManifestError extends Error {
    readonly code: PatchManifestErrorCode

    constructor(code: PatchManifestErrorCode, message: string) {
        super(`${code}: ${message}`)
        this.name = "PatchManifestError"
        this.code = code
    }
}

export interface PatchManifestArchive {
    readonly relativePath: string
    readonly layer: "common" | "medium" | "android"
    readonly order: number
    readonly bytes: number
    readonly sha256: string
}

export interface PatchManifest {
    readonly schema: 1
    readonly baseVersion: string | null
    readonly targetVersion: string
    readonly compatibleClient: "CN 1.8.1"
    readonly archives: readonly PatchManifestArchive[]
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ARCHIVE_KEYS = ["relativePath", "layer", "order", "bytes", "sha256"] as const

function fail(code: PatchManifestErrorCode, message: string): never {
    throw new PatchManifestError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value)
    return actual.length === expected.length && actual.every(key => expected.includes(key))
}

function parseVersion(
    value: unknown,
    code: "PATCH_BASE_VERSION_INVALID" | "PATCH_TARGET_VERSION_INVALID",
    field: string,
): string {
    if (typeof value !== "string") fail(code, `${field} must be a three-part numeric version`)
    const match = VERSION_PATTERN.exec(value)
    if (!match || !match.slice(1).every(component => Number.isSafeInteger(Number(component)))) {
        fail(code, `${field} must be a three-part numeric version`)
    }
    return value
}

function parseArchivePath(value: unknown): string {
    if (typeof value !== "string"
        || !value
        || !/^[\x21-\x7e]+$/.test(value)
        || value.includes("\\")
        || value.startsWith("/")
        || value.includes("//")
        || /[:?#%]/.test(value)
        || path.posix.normalize(value) !== value
        || value === ".."
        || value.startsWith("../")
        || !value.endsWith(".zip")) {
        fail("PATCH_ARCHIVE_PATH_INVALID", "archive relativePath must be a safe normalized ZIP path")
    }
    return value
}

function parseArchive(value: unknown): PatchManifestArchive {
    if (!isRecord(value) || !hasExactKeys(value, ARCHIVE_KEYS)) {
        fail("PATCH_ARCHIVES_INVALID", "each archive must contain exactly the runtime archive fields")
    }
    const relativePath = parseArchivePath(value.relativePath)
    const layer = value.layer
    if (layer !== "common" && layer !== "medium" && layer !== "android") {
        fail("PATCH_ARCHIVE_LAYER_INVALID", "archive layer must be common, medium, or android")
    }
    if (!Number.isSafeInteger(value.order) || (value.order as number) <= 0) {
        fail("PATCH_ARCHIVE_ORDER_INVALID", "archive order must be a positive safe integer")
    }
    if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0) {
        fail("PATCH_ARCHIVE_SIZE_INVALID", "archive bytes must be a positive safe integer")
    }
    if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
        fail("PATCH_ARCHIVE_SHA256_INVALID", "archive sha256 must be lowercase hexadecimal")
    }
    return deepFreeze({
        relativePath,
        layer,
        order: value.order as number,
        bytes: value.bytes as number,
        sha256: value.sha256,
    })
}

export function parsePatchManifest(value: unknown): PatchManifest {
    if (!isRecord(value) || value.schema !== 1) {
        fail("PATCH_MANIFEST_SCHEMA", "manifest must be an object with schema 1")
    }
    if (value.compatibleClient !== "CN 1.8.1") {
        fail("PATCH_CLIENT_INCOMPATIBLE", "compatibleClient must be CN 1.8.1")
    }
    const baseVersion = Object.prototype.hasOwnProperty.call(value, "baseVersion")
        ? parseVersion(value.baseVersion, "PATCH_BASE_VERSION_INVALID", "baseVersion")
        : null
    const targetVersion = parseVersion(
        value.targetVersion,
        "PATCH_TARGET_VERSION_INVALID",
        "targetVersion",
    )
    if (!Array.isArray(value.archives) || value.archives.length === 0) {
        fail("PATCH_ARCHIVES_INVALID", "archives must be a non-empty array")
    }
    const archives = value.archives.map(parseArchive)
    return deepFreeze({
        schema: 1,
        baseVersion,
        targetVersion,
        compatibleClient: "CN 1.8.1",
        archives,
    })
}
