import path from "node:path"

import { deepFreeze } from "../deep-freeze"
import type { ContentPaths } from "../paths"
import type { CdnCatalog } from "./types"

export type ArchiveSource =
    | { readonly kind: "baseline" }
    | { readonly kind: "patch"; readonly targetVersion: string }

export interface ArchiveSourceEntry {
    readonly relativePath: string
    readonly source: ArchiveSource
}

export interface ArchiveSourceManifest {
    readonly schemaVersion: 1
    readonly archives: readonly ArchiveSourceEntry[]
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function fail(code: "ARCHIVE_SOURCE_SCHEMA" | "ARCHIVE_SOURCE_COVERAGE" | "ARCHIVE_SOURCE_PATH" | "ARCHIVE_SOURCE_VERSION", message: string): never {
    throw new Error(`${code}: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actualKeys = Object.keys(value)
    return actualKeys.length === keys.length && actualKeys.every(key => keys.includes(key))
}

function requireSafeRelativePath(value: unknown): string {
    if (typeof value !== "string"
        || !value
        || !/^[\x21-\x7e]+$/.test(value)
        || value.includes("\\")
        || value.startsWith("/")
        || value.includes("//")
        || /[:?#%]/.test(value)
        || /^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) {
        return fail("ARCHIVE_SOURCE_PATH", "relativePath must be a safe relative path")
    }
    const normalized = path.posix.normalize(value)
    if (normalized !== value || normalized === ".." || normalized.startsWith("../")) {
        return fail("ARCHIVE_SOURCE_PATH", "relativePath must be normalized and contained")
    }
    return value
}

function parseSource(value: unknown): ArchiveSource {
    if (!isRecord(value) || typeof value.kind !== "string") {
        return fail("ARCHIVE_SOURCE_SCHEMA", "source must be an object with a kind")
    }
    if (value.kind === "baseline") {
        if (!hasOnlyKeys(value, ["kind"])) {
            return fail("ARCHIVE_SOURCE_SCHEMA", "baseline source has unexpected fields")
        }
        return deepFreeze({ kind: "baseline" })
    }
    if (value.kind === "patch") {
        if (!hasOnlyKeys(value, ["kind", "targetVersion"]) || typeof value.targetVersion !== "string") {
            return fail("ARCHIVE_SOURCE_SCHEMA", "patch source must include targetVersion")
        }
        const match = VERSION_PATTERN.exec(value.targetVersion)
        if (!match || !match.slice(1).every(component => Number.isSafeInteger(Number(component)))) {
            return fail("ARCHIVE_SOURCE_VERSION", "patch targetVersion must be a three-part numeric version")
        }
        return deepFreeze({ kind: "patch", targetVersion: value.targetVersion })
    }
    return fail("ARCHIVE_SOURCE_SCHEMA", "source kind must be baseline or patch")
}

function catalogArchivePaths(catalog: CdnCatalog): readonly string[] {
    const paths: string[] = []
    const seen = new Set<string>()
    for (const edge of catalog.edges) {
        for (const archive of edge.archives) {
            if (!seen.has(archive.relativePath)) {
                seen.add(archive.relativePath)
                paths.push(archive.relativePath)
            }
        }
    }
    return paths
}

function requireExactCoverage(
    catalog: CdnCatalog,
    entries: ReadonlyMap<string, ArchiveSource>,
): readonly string[] {
    const archivePaths = catalogArchivePaths(catalog)
    const expected = new Set(archivePaths)
    if (entries.size !== expected.size) {
        return fail("ARCHIVE_SOURCE_COVERAGE", "archive sources must cover each catalog archive exactly once")
    }
    for (const [relativePath] of entries) {
        requireSafeRelativePath(relativePath)
        if (!expected.has(relativePath)) {
            return fail("ARCHIVE_SOURCE_COVERAGE", `archive source is not in catalog: ${relativePath}`)
        }
    }
    for (const relativePath of archivePaths) {
        if (!entries.has(relativePath)) {
            return fail("ARCHIVE_SOURCE_COVERAGE", `archive source is missing: ${relativePath}`)
        }
    }
    return archivePaths
}

export function createArchiveSourceManifest(
    catalog: CdnCatalog,
    sources: ReadonlyMap<string, ArchiveSource>,
): ArchiveSourceManifest {
    const archivePaths = requireExactCoverage(catalog, sources)
    const archives = archivePaths.map(relativePath => ({
        relativePath,
        source: parseSource(sources.get(relativePath)),
    }))
    return deepFreeze({ schemaVersion: 1, archives })
}

export function parseArchiveSourceManifest(
    value: unknown,
    catalog: CdnCatalog,
): ArchiveSourceManifest {
    if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "archives"]) || value.schemaVersion !== 1 || !Array.isArray(value.archives)) {
        return fail("ARCHIVE_SOURCE_SCHEMA", "manifest must have schemaVersion 1 and archives")
    }

    const sources = new Map<string, ArchiveSource>()
    for (const entry of value.archives) {
        if (!isRecord(entry) || !hasOnlyKeys(entry, ["relativePath", "source"])) {
            return fail("ARCHIVE_SOURCE_SCHEMA", "archive source entry has invalid fields")
        }
        const relativePath = requireSafeRelativePath(entry.relativePath)
        if (sources.has(relativePath)) {
            return fail("ARCHIVE_SOURCE_COVERAGE", `archive source appears more than once: ${relativePath}`)
        }
        sources.set(relativePath, parseSource(entry.source))
    }
    return createArchiveSourceManifest(catalog, sources)
}

export function sourceFor(manifest: ArchiveSourceManifest, relativePath: string): ArchiveSource {
    const safePath = requireSafeRelativePath(relativePath)
    const entry = manifest.archives.find(candidate => candidate.relativePath === safePath)
    if (!entry) return fail("ARCHIVE_SOURCE_COVERAGE", `archive source is missing: ${safePath}`)
    return parseSource(entry.source)
}

export function sourceRoot(
    paths: Pick<ContentPaths, "cdnRoot" | "patchesRoot">,
    source: ArchiveSource,
): string {
    const parsedSource = parseSource(source)
    if (parsedSource.kind === "baseline") return paths.cdnRoot
    return path.join(paths.patchesRoot, parsedSource.targetVersion)
}
