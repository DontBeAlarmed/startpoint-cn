import { canonicalJsonBuffer, sha256Object } from "./canonical-json"
import { deepFreeze } from "../deep-freeze"

export const CONTENT_SCHEMA_VERSION = 1
export const CONTENT_RUNTIME_SCHEMA_VERSION = 1
export const CONTENT_GENERATOR_VERSION = 1

export type TableScope = "cdn" | "bundled" | "server"

export interface ContentTableReference {
    readonly object: `sha256:${string}`
    readonly scope: TableScope
    readonly converterId: string
    readonly converterVersion: number
    readonly sources: readonly string[]
}

export interface ContentReleaseManifest {
    readonly schemaVersion: 1
    readonly assetVersion: string
    readonly runtimeSchemaVersion: 1
    /** Generator version that produced this release; it may differ from the current constant. */
    readonly generatorVersion: number
    readonly releaseDigest: `sha256:${string}`
    readonly tables: Readonly<Record<string, ContentTableReference>>
    readonly catalog: { readonly object: `sha256:${string}` }
    readonly summary: { readonly object: `sha256:${string}` }
}

export interface ContentCurrentPointer {
    readonly schemaVersion: 1
    readonly assetVersion: string
    readonly release: string
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TABLE_PATH_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.json$/
const SEMVER_IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)"
const SEMVER_PATTERN = new RegExp(
    `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)`
    + `(?:-${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*)?`
    + "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
)

const RELEASE_KEYS = [
    "schemaVersion",
    "assetVersion",
    "runtimeSchemaVersion",
    "generatorVersion",
    "releaseDigest",
    "tables",
    "catalog",
    "summary",
] as const
const RELEASE_INPUT_KEYS = RELEASE_KEYS.filter(key => key !== "releaseDigest")

function requireRecord(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${field} must be an object`)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${field} must be a plain object`)
    }
    return value as Record<string, unknown>
}

function requireExactKeys(
    value: Record<string, unknown>,
    expectedKeys: readonly string[],
    field: string,
): void {
    const actualKeys = Object.keys(value)
    if (actualKeys.length !== expectedKeys.length
        || expectedKeys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
        throw new TypeError(`${field} has unknown or missing fields`)
    }
}

function requirePositiveInteger(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new TypeError(`${field} must be a positive safe integer`)
    }
    return value as number
}

function requireSemver(value: unknown, field: string): string {
    if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) {
        throw new TypeError(`${field} must be a semantic version`)
    }
    return value
}

function requireDigest(value: unknown, field: string): `sha256:${string}` {
    if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
        throw new TypeError(`${field} must be a lowercase SHA-256 digest`)
    }
    return value as `sha256:${string}`
}

function requireRelativePath(value: unknown, field: string): string {
    if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")) {
        throw new TypeError(`${field} must be a relative forward-slash path`)
    }
    if (/^[A-Za-z]:/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new TypeError(`${field} must be a relative forward-slash path`)
    }

    const segments = value.split("/")
    if (segments.some(segment => !segment || segment === "." || segment === "..")) {
        throw new TypeError(`${field} contains an invalid path segment`)
    }
    return value
}

function requireTableName(value: string): void {
    requireRelativePath(value, "content table name")
    if (!TABLE_PATH_PATTERN.test(value)) {
        throw new TypeError(`invalid content table name: ${value}`)
    }
}

function parseObjectReference(value: unknown, field: string): { readonly object: `sha256:${string}` } {
    const reference = requireRecord(value, field)
    requireExactKeys(reference, ["object"], field)
    return { object: requireDigest(reference.object, `${field}.object`) }
}

function parseTableReference(value: unknown, field: string): ContentTableReference {
    const reference = requireRecord(value, field)
    requireExactKeys(
        reference,
        ["object", "scope", "converterId", "converterVersion", "sources"],
        field,
    )

    if (reference.scope !== "cdn" && reference.scope !== "bundled" && reference.scope !== "server") {
        throw new TypeError(`${field}.scope must be cdn, bundled, or server`)
    }
    if (typeof reference.converterId !== "string"
        || !IDENTIFIER_PATTERN.test(reference.converterId)
        || reference.converterId.includes("..")) {
        throw new TypeError(`${field}.converterId must be a stable identifier`)
    }
    if (!Array.isArray(reference.sources)) {
        throw new TypeError(`${field}.sources must be an array`)
    }

    const sources = reference.sources.map((source, index) => (
        requireRelativePath(source, `${field}.sources[${index}]`)
    ))
    if (reference.scope !== "server" && sources.length === 0) {
        throw new TypeError(`${field}.sources must not be empty for ${reference.scope} tables`)
    }

    return {
        object: requireDigest(reference.object, `${field}.object`),
        scope: reference.scope,
        converterId: reference.converterId,
        converterVersion: requirePositiveInteger(
            reference.converterVersion,
            `${field}.converterVersion`,
        ),
        sources,
    }
}

function parseReleaseShape(value: unknown): ContentReleaseManifest {
    canonicalJsonBuffer(value)
    const manifest = requireRecord(value, "manifest")
    requireExactKeys(manifest, RELEASE_KEYS, "manifest")

    if (manifest.schemaVersion !== CONTENT_SCHEMA_VERSION) {
        throw new TypeError(`manifest.schemaVersion must be ${CONTENT_SCHEMA_VERSION}`)
    }
    if (manifest.runtimeSchemaVersion !== CONTENT_RUNTIME_SCHEMA_VERSION) {
        throw new TypeError(
            `manifest.runtimeSchemaVersion must be ${CONTENT_RUNTIME_SCHEMA_VERSION}`,
        )
    }

    const rawTables = requireRecord(manifest.tables, "manifest.tables")
    const tableEntries = Object.entries(rawTables)
    if (tableEntries.length === 0) throw new TypeError("manifest.tables must not be empty")

    const tables: Record<string, ContentTableReference> = {}
    for (const [tableName, reference] of tableEntries) {
        requireTableName(tableName)
        tables[tableName] = parseTableReference(reference, `manifest.tables.${tableName}`)
    }

    return {
        schemaVersion: CONTENT_SCHEMA_VERSION,
        assetVersion: requireSemver(manifest.assetVersion, "manifest.assetVersion"),
        runtimeSchemaVersion: CONTENT_RUNTIME_SCHEMA_VERSION,
        generatorVersion: requirePositiveInteger(
            manifest.generatorVersion,
            "manifest.generatorVersion",
        ),
        releaseDigest: requireDigest(manifest.releaseDigest, "manifest.releaseDigest"),
        tables,
        catalog: parseObjectReference(manifest.catalog, "manifest.catalog"),
        summary: parseObjectReference(manifest.summary, "manifest.summary"),
    }
}

function manifestDigestInput(
    manifest: Omit<ContentReleaseManifest, "releaseDigest">,
): Omit<ContentReleaseManifest, "releaseDigest"> {
    return {
        schemaVersion: manifest.schemaVersion,
        assetVersion: manifest.assetVersion,
        runtimeSchemaVersion: manifest.runtimeSchemaVersion,
        generatorVersion: manifest.generatorVersion,
        tables: manifest.tables,
        catalog: manifest.catalog,
        summary: manifest.summary,
    }
}

export function digestReleaseManifest(
    manifest: ContentReleaseManifest,
): `sha256:${string}` {
    const parsed = parseReleaseShape(manifest)
    return sha256Object(canonicalJsonBuffer(manifestDigestInput(parsed)))
}

export function createReleaseManifest(
    input: Omit<ContentReleaseManifest, "releaseDigest">,
): ContentReleaseManifest {
    canonicalJsonBuffer(input)
    const rawInput = requireRecord(input, "manifest input")
    requireExactKeys(rawInput, RELEASE_INPUT_KEYS, "manifest input")
    const provisional = parseReleaseShape({
        schemaVersion: rawInput.schemaVersion,
        assetVersion: rawInput.assetVersion,
        runtimeSchemaVersion: rawInput.runtimeSchemaVersion,
        generatorVersion: rawInput.generatorVersion,
        tables: rawInput.tables,
        catalog: rawInput.catalog,
        summary: rawInput.summary,
        releaseDigest: `sha256:${"0".repeat(64)}`,
    })
    return deepFreeze({
        ...manifestDigestInput(provisional),
        releaseDigest: digestReleaseManifest(provisional),
    })
}

export function parseReleaseManifest(value: unknown): ContentReleaseManifest {
    const manifest = parseReleaseShape(value)
    if (manifest.releaseDigest !== digestReleaseManifest(manifest)) {
        throw new TypeError("manifest.releaseDigest does not match manifest content")
    }
    return deepFreeze(manifest)
}

export function parseCurrentPointer(value: unknown): ContentCurrentPointer {
    canonicalJsonBuffer(value)
    const current = requireRecord(value, "current")
    requireExactKeys(current, ["schemaVersion", "assetVersion", "release"], "current")

    if (current.schemaVersion !== CONTENT_SCHEMA_VERSION) {
        throw new TypeError(`current.schemaVersion must be ${CONTENT_SCHEMA_VERSION}`)
    }
    const release = requireRelativePath(current.release, "current.release")
    const assetVersion = requireSemver(current.assetVersion, "current.assetVersion")
    const segments = release.split("/")
    const releasePrefix = `${assetVersion}-`
    if (segments.length !== 3
        || segments[0] !== "releases"
        || segments[2] !== "manifest.json"
        || !segments[1].startsWith(releasePrefix)
        || !/^[0-9a-f]{64}$/.test(segments[1].slice(releasePrefix.length))) {
        throw new TypeError(
            "current.release must match releases/<assetVersion>-<digest>/manifest.json",
        )
    }

    return deepFreeze({
        schemaVersion: CONTENT_SCHEMA_VERSION,
        assetVersion,
        release,
    })
}
