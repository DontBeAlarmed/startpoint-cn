import path from "node:path"

import { buildCdnCatalog } from "./catalog-builder"
import type { CdnCatalogArchiveInput, CdnCatalogInput } from "./types"

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ROOT_KEYS = ["schemaVersion", "baseline", "catalogInput", "entityLists"] as const
const CATALOG_INPUT_KEYS = ["archives", "installedBytes", "entityListsRelativePath"] as const
const ARCHIVE_KEYS = [
    "kind",
    "fromVersion",
    "toVersion",
    "platform",
    "layer",
    "order",
    "relativePath",
    "compressedBytes",
    "sha256",
] as const
const ENTITY_LISTS_KEYS = ["relativePath", "compressedBytes", "sha256"] as const

export interface CdnRuntimeManifest {
    readonly schemaVersion: 1
    readonly baseline: "cn-1.4.54"
    readonly catalogInput: CdnCatalogInput
    readonly entityLists: {
        readonly relativePath: string
        readonly compressedBytes: number
        readonly sha256: string
    }
}

function requireExactObject(
    value: unknown,
    keys: ReadonlyArray<string>,
    label: string,
): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`)
    }
    const record = value as Record<string, unknown>
    const actualKeys = Object.keys(record).sort()
    const expectedKeys = [...keys].sort()
    if (actualKeys.length !== expectedKeys.length
        || actualKeys.some((key, index) => key !== expectedKeys[index])) {
        throw new Error(`${label} contains missing or unknown fields`)
    }
    return record
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string") throw new Error(`${label} must be a string`)
    return value
}

function requireSafeInteger(value: unknown, label: string, minimum: number): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new Error(`${label} must be a safe integer greater than or equal to ${minimum}`)
    }
    return value as number
}

function requireSha256(value: unknown, label: string): string {
    const digest = requireString(value, label)
    if (!SHA256_PATTERN.test(digest)) throw new Error(`${label} must be a lowercase SHA-256 digest`)
    return digest
}

function requireSafeRelativePath(value: unknown, label: string): string {
    const relativePath = requireString(value, label)
    if (!relativePath
        || relativePath.includes("\\")
        || path.posix.isAbsolute(relativePath)
        || path.win32.isAbsolute(relativePath)
        || path.posix.normalize(relativePath) !== relativePath
        || relativePath === ".."
        || relativePath.startsWith("../")) {
        throw new Error(`${label} must be a normalized relative path`)
    }
    return relativePath
}

function parseArchive(value: unknown, index: number): CdnCatalogArchiveInput {
    const label = `catalogInput.archives[${index}]`
    const archive = requireExactObject(value, ARCHIVE_KEYS, label)
    const kind = requireString(archive.kind, `${label}.kind`)
    const fromVersion = archive.fromVersion
    const layer = requireString(archive.layer, `${label}.layer`)

    return {
        kind: kind as CdnCatalogArchiveInput["kind"],
        fromVersion: fromVersion === null
            ? null
            : requireString(fromVersion, `${label}.fromVersion`),
        toVersion: requireString(archive.toVersion, `${label}.toVersion`),
        platform: requireString(archive.platform, `${label}.platform`) as CdnCatalogArchiveInput["platform"],
        layer: layer as CdnCatalogArchiveInput["layer"],
        order: requireSafeInteger(archive.order, `${label}.order`, 1),
        relativePath: requireSafeRelativePath(archive.relativePath, `${label}.relativePath`),
        compressedBytes: requireSafeInteger(archive.compressedBytes, `${label}.compressedBytes`, 0),
        sha256: requireSha256(archive.sha256, `${label}.sha256`),
    }
}

function parseCatalogInput(value: unknown): CdnCatalogInput {
    const input = requireExactObject(value, CATALOG_INPUT_KEYS, "catalogInput")
    if (!Array.isArray(input.archives)) throw new Error("catalogInput.archives must be an array")
    return {
        archives: input.archives.map(parseArchive),
        installedBytes: requireSafeInteger(input.installedBytes, "catalogInput.installedBytes", 0),
        entityListsRelativePath: requireSafeRelativePath(
            input.entityListsRelativePath,
            "catalogInput.entityListsRelativePath",
        ),
    }
}

function parseEntityLists(value: unknown): CdnRuntimeManifest["entityLists"] {
    const entityLists = requireExactObject(value, ENTITY_LISTS_KEYS, "entityLists")
    return {
        relativePath: requireSafeRelativePath(entityLists.relativePath, "entityLists.relativePath"),
        compressedBytes: requireSafeInteger(entityLists.compressedBytes, "entityLists.compressedBytes", 0),
        sha256: requireSha256(entityLists.sha256, "entityLists.sha256"),
    }
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    return Object.freeze(value)
}

function orderCatalogInput(input: CdnCatalogInput): CdnCatalogInput {
    const catalog = buildCdnCatalog(input)
    if (catalog.targetVersion !== "1.4.54") {
        throw new Error(`manifest Catalog target must be 1.4.54, received ${catalog.targetVersion}`)
    }
    const byPath = new Map(input.archives.map(archive => [archive.relativePath, archive]))
    const seen = new Set<string>()
    const archives: CdnCatalogArchiveInput[] = []

    for (const edge of catalog.edges) {
        for (const catalogArchive of edge.archives) {
            if (seen.has(catalogArchive.relativePath)) continue
            const archive = byPath.get(catalogArchive.relativePath)
            if (!archive) throw new Error(`missing catalog input archive ${catalogArchive.relativePath}`)
            seen.add(catalogArchive.relativePath)
            archives.push(archive)
        }
    }
    return {
        archives,
        installedBytes: input.installedBytes,
        entityListsRelativePath: input.entityListsRelativePath,
    }
}

export function parseCdnRuntimeManifest(value: unknown): CdnRuntimeManifest {
    const manifest = requireExactObject(value, ROOT_KEYS, "manifest")
    if (manifest.schemaVersion !== 1) throw new Error("manifest.schemaVersion must be 1")
    if (manifest.baseline !== "cn-1.4.54") throw new Error("manifest.baseline must be cn-1.4.54")

    const catalogInput = orderCatalogInput(parseCatalogInput(manifest.catalogInput))
    const entityLists = parseEntityLists(manifest.entityLists)
    if (entityLists.relativePath !== catalogInput.entityListsRelativePath) {
        throw new Error("entityLists.relativePath must match catalogInput.entityListsRelativePath")
    }

    return deepFreeze({
        schemaVersion: 1,
        baseline: "cn-1.4.54",
        catalogInput,
        entityLists,
    })
}

export function createCdnRuntimeManifest(
    input: CdnCatalogInput,
    entityLists: CdnRuntimeManifest["entityLists"],
): CdnRuntimeManifest {
    return parseCdnRuntimeManifest({
        schemaVersion: 1,
        baseline: "cn-1.4.54",
        catalogInput: input,
        entityLists,
    })
}

export function serializeCdnRuntimeManifest(manifest: CdnRuntimeManifest): string {
    return `${JSON.stringify(parseCdnRuntimeManifest(manifest), null, 2)}\n`
}
