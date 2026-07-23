import path from "node:path"

import { buildCdnCatalog } from "../cdn/catalog-builder"
import type { CdnCatalog, CdnCatalogInput } from "../cdn/types"
import {
    resolveContentPaths,
    type ContentPathEnvironment,
    type ContentPaths,
} from "../paths"
import { ArchiveIndex } from "./archive-index"
import { acquireContentSyncLock, type ContentSyncLock } from "./lock"
import { ContentObjectStore } from "./object-store"
import { createDefaultContentTableBuilder } from "./release-builder"
import {
    CONTENT_GENERATOR_VERSION,
    CONTENT_RUNTIME_SCHEMA_VERSION,
    CONTENT_SCHEMA_VERSION,
    type ContentCurrentPointer,
    type ContentReleaseManifest,
    type ContentTableReference,
} from "./schema"
import {
    materializeContentCatalogInput,
    scanContentTarget,
    type ContentTargetScan,
} from "./scanner"
import { TABLE_SOURCES, type TableSourceDefinition } from "./table-registry"

export type ContentSyncMode = "normal" | "check" | "force"
export type ContentSyncReason =
    | "missing"
    | "asset-version"
    | "generator-version"
    | "forced"
    | "up-to-date"

export class ContentSyncCleanupError extends Error {
    readonly synchronizationError: unknown
    readonly releaseError: unknown

    constructor(synchronizationError: unknown, releaseError: unknown) {
        const synchronizationMessage = synchronizationError instanceof Error
            ? synchronizationError.message
            : String(synchronizationError)
        const releaseMessage = releaseError instanceof Error
            ? releaseError.message
            : String(releaseError)
        super(
            `content synchronization failed: ${synchronizationMessage}; `
            + `lock release failed: ${releaseMessage}`,
        )
        this.name = "ContentSyncCleanupError"
        this.synchronizationError = synchronizationError
        this.releaseError = releaseError
    }
}

export interface ContentSyncOptions {
    readonly projectRoot: string
    readonly env?: ContentPathEnvironment
    readonly mode?: ContentSyncMode
    readonly generatorVersion?: number
}

export interface ContentTableBuildContext {
    readonly projectRoot: string
    readonly paths: ContentPaths
    readonly scan: ContentTargetScan
    readonly catalog: CdnCatalog
    readonly archiveIndex: ArchiveIndex
    readonly definitions: readonly TableSourceDefinition[]
}

export interface ContentTableBuilder {
    build(context: ContentTableBuildContext): Promise<
        ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>
    >
}

export interface ContentSyncResult {
    readonly status: "synchronized" | "skipped" | "check"
    readonly action: "synchronize" | "skip"
    readonly targetVersion: string
    readonly currentVersion: string | null
    readonly reason: ContentSyncReason
    readonly releaseDigest?: `sha256:${string}`
}

interface CurrentRelease {
    readonly current: ContentCurrentPointer
    readonly manifest: ContentReleaseManifest
}

interface ContentStore {
    readCurrentRelease?(): Promise<CurrentRelease | null>
    readCurrent(): Promise<ContentCurrentPointer | null>
    readRelease(pointer: ContentCurrentPointer | string): Promise<ContentReleaseManifest>
    writeObject(value: unknown): Promise<`sha256:${string}`>
    writeRelease(
        input: Omit<ContentReleaseManifest, "releaseDigest">,
    ): Promise<ContentReleaseManifest>
    activate(manifest: ContentReleaseManifest): Promise<ContentCurrentPointer>
}

export interface ContentSyncDependencies {
    readonly resolvePaths?: typeof resolveContentPaths
    readonly createStore?: (paths: ContentPaths) => ContentStore
    readonly acquireLock?: (
        contentStateDir: string,
    ) => Promise<ContentSyncLock>
    readonly scanTarget?: typeof scanContentTarget
    readonly materializeCatalog?: (
        scan: ContentTargetScan,
        options?: Parameters<typeof materializeContentCatalogInput>[1],
    ) => Promise<CdnCatalogInput>
    readonly buildCatalog?: (input: CdnCatalogInput) => CdnCatalog
    readonly buildArchiveIndex?: (
        catalog: CdnCatalog,
        cdnRoot: string,
    ) => Promise<ArchiveIndex>
    readonly tableBuilder?: ContentTableBuilder
    readonly tableSources?: readonly TableSourceDefinition[]
}

const defaultTableBuilder = createDefaultContentTableBuilder()

function requireMode(mode: ContentSyncMode): ContentSyncMode {
    if (mode !== "normal" && mode !== "check" && mode !== "force") {
        throw new TypeError("content sync mode must be normal, check, or force")
    }
    return mode
}

function requireGeneratorVersion(version: number): number {
    if (!Number.isSafeInteger(version) || version <= 0) {
        throw new TypeError("generatorVersion must be a positive safe integer")
    }
    return version
}

async function readCurrentRelease(store: ContentStore): Promise<CurrentRelease | null> {
    if (store.readCurrentRelease) return store.readCurrentRelease()
    const current = await store.readCurrent()
    if (current === null) return null
    return { current, manifest: await store.readRelease(current) }
}

function decideReason(
    mode: ContentSyncMode,
    targetVersion: string,
    current: CurrentRelease | null,
    generatorVersion: number,
): ContentSyncReason {
    if (mode === "force") return "forced"
    if (current === null) return "missing"
    if (current.manifest.assetVersion !== targetVersion) return "asset-version"
    if (current.manifest.generatorVersion !== generatorVersion) return "generator-version"
    return "up-to-date"
}

function resultWithoutRelease(
    status: "check" | "skipped",
    targetVersion: string,
    current: CurrentRelease | null,
    reason: ContentSyncReason,
): ContentSyncResult {
    return {
        status,
        action: reason === "up-to-date" ? "skip" : "synchronize",
        targetVersion,
        currentVersion: current?.manifest.assetVersion ?? null,
        reason,
    }
}

function tableEntries(
    built: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>,
): ReadonlyMap<string, unknown> {
    if (built instanceof Map) return built
    if (!built || typeof built !== "object" || Array.isArray(built)) {
        throw new TypeError("content table builder must return a Map or object")
    }
    return new Map(Object.entries(built))
}

function validateBuiltTables(
    built: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>,
    definitions: readonly TableSourceDefinition[],
): ReadonlyMap<string, unknown> {
    const values = tableEntries(built)
    const expected = new Set(definitions.map(definition => definition.tableName))
    const missing = [...expected].filter(tableName => !values.has(tableName)).sort()
    const extra = [...values.keys()].filter(tableName => !expected.has(tableName)).sort()
    if (missing.length > 0 || extra.length > 0) {
        const details = [
            ...(missing.length === 0 ? [] : [`missing tables: ${missing.join(", ")}`]),
            ...(extra.length === 0 ? [] : [`extra tables: ${extra.join(", ")}`]),
        ]
        throw new Error(`content table builder output does not match registry (${details.join("; ")})`)
    }
    return values
}

function createSummary(
    scan: ContentTargetScan,
    generatorVersion: number,
    tableCount: number,
): unknown {
    return {
        schemaVersion: CONTENT_SCHEMA_VERSION,
        assetVersion: scan.targetVersion,
        generatorVersion,
        entityListsRelativePath: scan.entityListsRelativePath,
        counts: {
            archives: scan.archives.length,
            ignoredPaths: scan.ignoredPaths.length,
            tables: tableCount,
        },
    }
}

async function synchronize(
    projectRoot: string,
    paths: ContentPaths,
    store: ContentStore,
    scan: ContentTargetScan,
    current: CurrentRelease | null,
    reason: ContentSyncReason,
    generatorVersion: number,
    dependencies: ContentSyncDependencies,
): Promise<ContentSyncResult> {
    const materialize = dependencies.materializeCatalog ?? materializeContentCatalogInput
    const buildCatalog = dependencies.buildCatalog ?? buildCdnCatalog
    const buildArchiveIndex = dependencies.buildArchiveIndex
        ?? ((catalog, cdnRoot) => ArchiveIndex.build(catalog, cdnRoot))
    const definitions = dependencies.tableSources ?? TABLE_SOURCES
    const tableBuilder = dependencies.tableBuilder ?? defaultTableBuilder

    const catalogInput = await materialize(scan)
    const catalog = buildCatalog(catalogInput)
    if (catalog.targetVersion !== scan.targetVersion) {
        throw new Error("materialized catalog target does not match scanned target")
    }
    const archiveIndex = await buildArchiveIndex(catalog, paths.cdnRoot)
    const built = validateBuiltTables(await tableBuilder.build({
        projectRoot,
        paths,
        scan,
        catalog,
        archiveIndex,
        definitions,
    }), definitions)

    const tables: Record<string, ContentTableReference> = {}
    for (const definition of definitions) {
        const object = await store.writeObject(built.get(definition.tableName))
        tables[definition.tableName] = {
            object,
            scope: definition.scope,
            converterId: definition.converterId,
            converterVersion: definition.converterVersion,
            sources: definition.manifestSources,
        }
    }
    const catalogObject = await store.writeObject(catalog)
    const summaryObject = await store.writeObject(
        createSummary(scan, generatorVersion, definitions.length),
    )
    const manifest = await store.writeRelease({
        schemaVersion: CONTENT_SCHEMA_VERSION,
        assetVersion: scan.targetVersion,
        runtimeSchemaVersion: CONTENT_RUNTIME_SCHEMA_VERSION,
        generatorVersion,
        tables,
        catalog: { object: catalogObject },
        summary: { object: summaryObject },
    })
    await store.activate(manifest)
    return {
        status: "synchronized",
        action: "synchronize",
        targetVersion: scan.targetVersion,
        currentVersion: current?.manifest.assetVersion ?? null,
        reason,
        releaseDigest: manifest.releaseDigest,
    }
}

export async function runContentSync(
    options: ContentSyncOptions,
    dependencies: ContentSyncDependencies = {},
): Promise<ContentSyncResult> {
    if (!options.projectRoot || !path.isAbsolute(options.projectRoot)) {
        throw new TypeError("projectRoot must be an absolute path")
    }
    const projectRoot = path.resolve(options.projectRoot)
    const mode = requireMode(options.mode ?? "normal")
    const generatorVersion = requireGeneratorVersion(
        options.generatorVersion ?? CONTENT_GENERATOR_VERSION,
    )
    const resolvePaths = dependencies.resolvePaths ?? resolveContentPaths
    const paths = resolvePaths({ projectRoot, env: options.env ?? process.env })
    const createStore = dependencies.createStore ?? (resolved => new ContentObjectStore(resolved))
    const store = createStore(paths)
    const scanTarget = dependencies.scanTarget ?? scanContentTarget

    if (mode === "check") {
        const scan = await scanTarget(paths)
        const current = await readCurrentRelease(store)
        const reason = decideReason(mode, scan.targetVersion, current, generatorVersion)
        return resultWithoutRelease("check", scan.targetVersion, current, reason)
    }

    const acquireLock = dependencies.acquireLock ?? acquireContentSyncLock
    const lock = await acquireLock(paths.contentStateDir)
    let synchronizationError: unknown
    let synchronizationFailed = false
    try {
        const scan = await scanTarget(paths)
        const current = await readCurrentRelease(store)
        const reason = decideReason(mode, scan.targetVersion, current, generatorVersion)
        if (reason === "up-to-date") {
            return resultWithoutRelease("skipped", scan.targetVersion, current, reason)
        }
        return await synchronize(
            projectRoot,
            paths,
            store,
            scan,
            current,
            reason,
            generatorVersion,
            dependencies,
        )
    } catch (error) {
        synchronizationFailed = true
        synchronizationError = error
        throw error
    } finally {
        try {
            await lock.release()
        } catch (releaseError) {
            if (synchronizationFailed) {
                throw new ContentSyncCleanupError(synchronizationError, releaseError)
            }
            throw releaseError
        }
    }
}
