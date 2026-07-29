import fs from "node:fs"
import path from "node:path"

import { deepFreeze } from "../deep-freeze"
import type { AssetMode } from "../cdn/asset-mode"
import { CdnCatalogLoader } from "../cdn/catalog-loader"
import type { CdnCatalog } from "../cdn/types"
import {
    ARCHIVE_SOURCE_SUMMARY_GENERATOR_VERSION,
    createBaselineArchiveSourceManifest,
    parseArchiveSourceSummary,
    type ArchiveSourceManifest,
} from "../cdn/archive-sources"
import {
    ContentRepository,
    type ContentRepositoryDependencies,
    type ContentRepositoryInfo,
} from "./content-repository"
import {
    resolveContentPaths,
    resolveContentRuntimePaths,
    type ContentPathEnvironment,
    type ContentPaths,
    type ContentRuntimePaths,
} from "../paths"
import {
    ContentObjectStore,
    type ContentCurrentReleaseSnapshot,
} from "../sync/object-store"
import type { CatalogLoaderDependencies } from "../cdn/catalog-loader"

export interface ReadonlyContentRepository {
    info(): ContentRepositoryInfo
    table<T>(tableName: string): T
}

export interface ContentSnapshot {
    readonly cdn: CdnCatalog
    readonly archiveSources: ArchiveSourceManifest
    readonly repository: ReadonlyContentRepository
}

export type ContentSnapshotErrorCode = "CONTENT_SNAPSHOT_NOT_INITIALIZED"

export class ContentSnapshotError extends Error {
    readonly code: ContentSnapshotErrorCode

    constructor(code: ContentSnapshotErrorCode, message: string) {
        super(`${code}: ${message}`)
        this.name = "ContentSnapshotError"
        this.code = code
    }
}

export class ContentSnapshotSourcesError extends Error {
    readonly errors: readonly unknown[]

    constructor(errors: readonly unknown[]) {
        super("content catalog and repository sources both failed")
        this.name = "ContentSnapshotSourcesError"
        this.errors = Object.freeze([...errors])
    }
}

export interface ContentCatalogSource {
    load(): Promise<CdnCatalog>
}

export interface ContentRepositorySource {
    load(): Promise<ReadonlyContentRepository>
}

export interface ContentSnapshotProviderOptions {
    readonly catalogSource?: ContentCatalogSource
    readonly repositorySource?: ContentRepositorySource
    readonly snapshotSource?: ContentSnapshotSource
}

export interface ContentSnapshotSource {
    load(): Promise<ContentSnapshot>
}

export function resolveContentProjectRoot(moduleDirectory: string): string {
    return path.resolve(moduleDirectory, "../../..")
}

type Settled<T> =
    | { readonly status: "fulfilled"; readonly value: T }
    | { readonly status: "rejected"; readonly reason: unknown }

function settle<T>(load: () => Promise<T>): Promise<Settled<T>> {
    let pending: Promise<T>
    try {
        pending = load()
    } catch (reason) {
        return Promise.resolve({ status: "rejected", reason })
    }
    return pending.then(
        value => ({ status: "fulfilled", value }),
        reason => ({ status: "rejected", reason }),
    )
}

export class ContentSnapshotProvider {
    private readonly catalogSource: ContentCatalogSource | null
    private readonly repositorySource: ContentRepositorySource | null
    private readonly snapshotSource: ContentSnapshotSource | null
    private snapshot: ContentSnapshot | null = null
    private initialization: Promise<ContentSnapshot> | null = null

    constructor(options: ContentSnapshotProviderOptions) {
        const pairedSources = Boolean(options.catalogSource && options.repositorySource)
        const directSource = Boolean(options.snapshotSource)
        if (pairedSources === directSource
            || Boolean(options.catalogSource) !== Boolean(options.repositorySource)) {
            throw new TypeError(
                "content snapshot provider requires either snapshotSource or both paired sources",
            )
        }
        this.catalogSource = options.catalogSource ?? null
        this.repositorySource = options.repositorySource ?? null
        this.snapshotSource = options.snapshotSource ?? null
    }

    initialize(): Promise<ContentSnapshot> {
        if (this.snapshot) return Promise.resolve(this.snapshot)
        if (this.initialization) return this.initialization

        const initialization = (this.snapshotSource
            ? this.snapshotSource.load()
            : loadSnapshotPair(
                () => (this.catalogSource as ContentCatalogSource).load(),
                () => (this.repositorySource as ContentRepositorySource).load(),
            ))
            .then(snapshot => deepFreeze(snapshot))
            .then(snapshot => {
                this.snapshot = snapshot
                return snapshot
            })
        this.initialization = initialization
        void initialization.then(
            () => {
                if (this.initialization === initialization) this.initialization = null
            },
            () => {
                if (this.initialization === initialization) this.initialization = null
            },
        )
        return initialization
    }

    get(): ContentSnapshot {
        if (!this.snapshot) {
            throw new ContentSnapshotError(
                "CONTENT_SNAPSHOT_NOT_INITIALIZED",
                "content snapshot has not been initialized",
            )
        }
        return this.snapshot
    }
}

export interface ContentSnapshotRuntimeConfiguration {
    readonly assetMode: AssetMode
    readonly localCdn: boolean
}

export interface InitializeContentSnapshotOptions {
    readonly assetMode?: AssetMode
    readonly localCdn?: boolean
}

export type ContentSnapshotConfigurationErrorCode =
    | "CONTENT_SNAPSHOT_CONFIGURATION_CONFLICT"
    | "CONTENT_SNAPSHOT_CONFIGURATION_INVALID"

export class ContentSnapshotConfigurationError extends Error {
    readonly code: ContentSnapshotConfigurationErrorCode

    constructor(code: ContentSnapshotConfigurationErrorCode, message: string) {
        super(message)
        this.name = "ContentSnapshotConfigurationError"
        this.code = code
    }
}

export interface ConfiguredContentSnapshotProviderDependencies {
    readonly createProvider: (
        configuration: ContentSnapshotRuntimeConfiguration,
    ) => ContentSnapshotProvider
}

interface ConfiguredContentSnapshotState {
    configuration: ContentSnapshotRuntimeConfiguration | null
    provider: ContentSnapshotProvider | null
}

function normalizeRuntimeConfiguration(
    options: InitializeContentSnapshotOptions,
): ContentSnapshotRuntimeConfiguration {
    const assetMode = options.assetMode ?? "local"
    const expectedLocalCdn = assetMode === "local"
    const localCdn = options.localCdn ?? expectedLocalCdn
    if (localCdn !== expectedLocalCdn) {
        throw new ContentSnapshotConfigurationError(
            "CONTENT_SNAPSHOT_CONFIGURATION_INVALID",
            "content snapshot runtime configuration is invalid",
        )
    }
    return Object.freeze({ assetMode, localCdn })
}

function lockRuntimeConfiguration(
    state: ConfiguredContentSnapshotState,
    requested: ContentSnapshotRuntimeConfiguration,
): void {
    const current = state.configuration
    if (current === null) {
        state.configuration = requested
        return
    }
    if (current.assetMode !== requested.assetMode || current.localCdn !== requested.localCdn) {
        throw new ContentSnapshotConfigurationError(
            "CONTENT_SNAPSHOT_CONFIGURATION_CONFLICT",
            "content snapshot runtime configuration is already locked",
        )
    }
}

export class ConfiguredContentSnapshotProvider extends ContentSnapshotProvider {
    private readonly runtimeState: ConfiguredContentSnapshotState

    constructor(dependencies: ConfiguredContentSnapshotProviderDependencies) {
        const state: ConfiguredContentSnapshotState = {
            configuration: null,
            provider: null,
        }
        super({
            snapshotSource: Object.freeze({
                load(): Promise<ContentSnapshot> {
                    if (state.configuration === null) {
                        state.configuration = normalizeRuntimeConfiguration({})
                    }
                    if (state.provider === null) {
                        state.provider = dependencies.createProvider(state.configuration)
                    }
                    return state.provider.initialize()
                },
            }),
        })
        this.runtimeState = state
    }

    initialize(options: InitializeContentSnapshotOptions = {}): Promise<ContentSnapshot> {
        lockRuntimeConfiguration(this.runtimeState, normalizeRuntimeConfiguration(options))
        return super.initialize()
    }
}

export function createConfiguredContentSnapshotProvider(
    dependencies: ConfiguredContentSnapshotProviderDependencies,
): ConfiguredContentSnapshotProvider {
    return new ConfiguredContentSnapshotProvider(dependencies)
}

async function loadSnapshotPair(
    loadCatalog: () => Promise<CdnCatalog>,
    loadRepository: () => Promise<ReadonlyContentRepository>,
    loadArchiveSources?: (catalog: CdnCatalog) => Promise<ArchiveSourceManifest>,
): Promise<ContentSnapshot> {
    return Promise.all([
        settle(loadCatalog),
        settle(loadRepository),
    ]).then(async ([catalogResult, repositoryResult]) => {
        const errors: unknown[] = []
        if (catalogResult.status === "rejected") errors.push(catalogResult.reason)
        if (repositoryResult.status === "rejected") errors.push(repositoryResult.reason)
        if (errors.length === 1) throw errors[0]
        if (errors.length === 2) throw new ContentSnapshotSourcesError(errors)
        if (catalogResult.status !== "fulfilled"
            || repositoryResult.status !== "fulfilled") {
            throw new Error("content snapshot source settlement is inconsistent")
        }
        const archiveSources = loadArchiveSources
            ? await loadArchiveSources(catalogResult.value)
            : createBaselineArchiveSourceManifest(catalogResult.value)
        return deepFreeze({
            cdn: catalogResult.value,
            archiveSources,
            repository: repositoryResult.value,
        })
    })
}

export interface ProjectContentSnapshotProviderDependencies {
    readonly resolvePaths?: (options: {
        readonly projectRoot: string
        readonly env: ContentPathEnvironment
    }) => ContentPaths
    readonly resolveRuntimePaths?: (options: {
        readonly projectRoot: string
        readonly env: ContentPathEnvironment
    }) => ContentRuntimePaths
    readonly createStore?: (
        paths: ContentRuntimePaths | Pick<ContentRuntimePaths, "contentRootDir">,
    ) => Pick<ContentObjectStore, "readCurrentReleaseSnapshot">
    readonly catalog?: CatalogLoaderDependencies
    readonly repository?: ContentRepositoryDependencies
    readonly warningSink?: Pick<NodeJS.WriteStream, "write">
}

export interface ProjectContentSnapshotProviderOptions {
    readonly projectRoot: string
    readonly env?: ContentPathEnvironment
    readonly localCdn?: boolean
    readonly dependencies?: ProjectContentSnapshotProviderDependencies
}

function isMissingPath(error: unknown): boolean {
    return Boolean(error
        && typeof error === "object"
        && ((error as NodeJS.ErrnoException).code === "ENOENT"
            || (error as NodeJS.ErrnoException).code === "ENOTDIR"))
}

async function legacyCurrentEntryExists(contentRootDir: string): Promise<boolean> {
    try {
        await fs.promises.lstat(path.join(contentRootDir, "current.json"))
        return true
    } catch (error) {
        if (isMissingPath(error)) return false
        throw error
    }
}

async function selectProjectReleaseSnapshot(
    paths: ContentRuntimePaths,
    createStore: NonNullable<ProjectContentSnapshotProviderDependencies["createStore"]>,
    warningSink: Pick<NodeJS.WriteStream, "write">,
): Promise<ContentCurrentReleaseSnapshot | null> {
    if (paths.layout === "legacy") {
        return createStore(paths).readCurrentReleaseSnapshot()
    }

    const modern = await createStore(paths).readCurrentReleaseSnapshot()
    if (modern !== null) {
        if (await legacyCurrentEntryExists(paths.contentRootDir)) {
            warningSink.write("警告 [CONTENT_LEGACY_CURRENT_IGNORED]：已忽略旧版内容快照\n")
        }
        return modern
    }

    if (!await legacyCurrentEntryExists(paths.contentRootDir)) return null
    return createStore({ contentRootDir: paths.contentRootDir })
        .readCurrentReleaseSnapshot()
}

export function createProjectContentSnapshotProvider({
    projectRoot,
    env = process.env,
    localCdn = true,
    dependencies = {},
}: ProjectContentSnapshotProviderOptions): ContentSnapshotProvider {
    const resolvedProjectRoot = path.resolve(projectRoot)
    const catalogLoader = new CdnCatalogLoader({
        projectRoot: resolvedProjectRoot,
        env,
        localCdn,
        dependencies: dependencies.catalog,
    })
    const snapshotSource: ContentSnapshotSource = Object.freeze({
        async load(): Promise<ContentSnapshot> {
            const resolvePaths = dependencies.resolvePaths ?? resolveContentPaths
            const resolveRuntimePaths = dependencies.resolveRuntimePaths
                ?? dependencies.resolvePaths
                ?? resolveContentRuntimePaths
            const paths = localCdn
                ? resolvePaths({ projectRoot: resolvedProjectRoot, env })
                : resolveRuntimePaths({
                    projectRoot: resolvedProjectRoot,
                    env: { ...env, CDN_DIR: undefined },
                })
            const createStore = dependencies.createStore
                ?? (resolved => new ContentObjectStore(resolved))
            const release = await selectProjectReleaseSnapshot(
                paths,
                createStore,
                dependencies.warningSink ?? process.stderr,
            )
            return loadSnapshotPair(
                () => catalogLoader.loadFromSnapshot(release, paths),
                () => ContentRepository.loadFromSnapshot(
                    { projectRoot: resolvedProjectRoot, env },
                    release,
                    dependencies.repository,
                    paths,
                ),
                async catalog => parseArchiveSourceSummary(
                    release?.objects[release.manifest.summary.object],
                    catalog,
                    release === null
                        || release.manifest.generatorVersion < ARCHIVE_SOURCE_SUMMARY_GENERATOR_VERSION,
                ),
            )
        },
    })
    return new ContentSnapshotProvider({ snapshotSource })
}

export const productionCatalogLoader = new CdnCatalogLoader({
    projectRoot: resolveContentProjectRoot(__dirname),
})

export const productionRepositorySource: ContentRepositorySource = Object.freeze({
    load: () => ContentRepository.load({
        projectRoot: resolveContentProjectRoot(__dirname),
    }),
})

export const productionContentSnapshotProvider = createConfiguredContentSnapshotProvider({
    createProvider: configuration => (
        createProjectContentSnapshotProvider({
            projectRoot: resolveContentProjectRoot(__dirname),
            localCdn: configuration.localCdn,
        })
    ),
})

export function initializeContentSnapshot(
    options: InitializeContentSnapshotOptions = {},
): Promise<ContentSnapshot> {
    return productionContentSnapshotProvider.initialize(options)
}

export function getContentSnapshot(): ContentSnapshot {
    return productionContentSnapshotProvider.get()
}
