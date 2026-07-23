import path from "node:path"

import { BUNDLED_CDN_CATALOG_VERSION } from "../constants"
import {
    resolveContentPaths,
    resolveContentRuntimePaths,
    type ContentPathEnvironment,
    type ContentPaths,
    type ContentRuntimePaths,
} from "../paths"
import { deepFreeze } from "../deep-freeze"
import { readContentRuntimeText } from "../runtime/runtime-file-reader"
import { canonicalJsonBuffer } from "../sync/canonical-json"
import {
    ContentObjectStore,
    type ContentCurrentReleaseSnapshot,
} from "../sync/object-store"
import { buildCdnCatalog } from "./catalog-builder"
import {
    parseCdnRuntimeManifest,
    validateCdnRuntimeFiles,
    type CdnRuntimeManifest,
} from "./runtime-manifest"
import type { CdnCatalog, CdnCatalogInput } from "./types"

export type CatalogLoaderErrorCode =
    | "CATALOG_NOT_LOADED"
    | "RUNTIME_MANIFEST_READ"
    | "RUNTIME_MANIFEST_SCHEMA"
    | "RELEASE_CATALOG_SCHEMA"

export class CatalogLoaderError extends Error {
    readonly code: CatalogLoaderErrorCode
    readonly cause: unknown

    constructor(code: CatalogLoaderErrorCode, message: string, cause?: unknown) {
        super(`${code}: ${message}`)
        this.name = "CatalogLoaderError"
        this.code = code
        this.cause = cause
    }
}

export interface CatalogLoaderDependencies {
    readonly resolvePaths?: (options: {
        readonly projectRoot: string
        readonly env: ContentPathEnvironment
    }) => ContentPaths
    readonly resolveRuntimePaths?: (options: {
        readonly projectRoot: string
        readonly env: ContentPathEnvironment
    }) => ContentRuntimePaths
    readonly build?: (input: CdnCatalogInput) => CdnCatalog
    readonly readRuntimeManifest?: (manifestPath: string) => Promise<unknown>
    readonly validateRuntimeFiles?: (
        manifest: CdnRuntimeManifest,
        paths: ContentRuntimePaths & Pick<ContentPaths, "cdnRoot">,
    ) => Promise<void>
    readonly createStore?: (
        paths: ContentRuntimePaths,
    ) => {
        readCurrentReleaseSnapshot():
            | ContentCurrentReleaseSnapshot
            | null
            | Promise<ContentCurrentReleaseSnapshot | null>
    }
}

export interface CdnCatalogLoaderOptions {
    readonly projectRoot: string
    readonly env?: ContentPathEnvironment
    readonly localCdn?: boolean
    readonly dependencies?: CatalogLoaderDependencies
}

const RUNTIME_MANIFEST_RELATIVE_PATH = `cdn/catalog-cn-${BUNDLED_CDN_CATALOG_VERSION}.json`

function runtimeManifestError(
    code: "RUNTIME_MANIFEST_READ" | "RUNTIME_MANIFEST_SCHEMA",
    message: string,
): CatalogLoaderError {
    return new CatalogLoaderError(code, message)
}

function hasCdnRoot(
    paths: ContentRuntimePaths,
): paths is ContentRuntimePaths & Pick<ContentPaths, "cdnRoot"> {
    const candidate = paths as Partial<ContentPaths>
    return typeof candidate.cdnRoot === "string"
}

async function readRuntimeManifestFile(contentRuntimeDir: string): Promise<unknown> {
    let content: string
    try {
        content = await readContentRuntimeText(
            contentRuntimeDir,
            RUNTIME_MANIFEST_RELATIVE_PATH,
            "runtime catalog manifest",
        )
    } catch {
        throw runtimeManifestError(
            "RUNTIME_MANIFEST_READ",
            `cannot read ${RUNTIME_MANIFEST_RELATIVE_PATH}`,
        )
    }
    try {
        return JSON.parse(content)
    } catch {
        throw runtimeManifestError(
            "RUNTIME_MANIFEST_SCHEMA",
            `${RUNTIME_MANIFEST_RELATIVE_PATH} is not valid JSON`,
        )
    }
}

function releaseCatalogError(message: string): CatalogLoaderError {
    return new CatalogLoaderError("RELEASE_CATALOG_SCHEMA", message)
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
    return Boolean(value
        && (typeof value === "object" || typeof value === "function")
        && typeof (value as PromiseLike<T>).then === "function")
}

function parseReleaseCatalog(
    value: unknown,
    build: (input: CdnCatalogInput) => CdnCatalog,
): CdnCatalog {
    try {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("catalog must be an object")
        }
        const source = value as Record<string, unknown>
        if (!Array.isArray(source.edges)) throw new Error("catalog edges must be an array")
        const archives: CdnCatalogInput["archives"][number][] = []
        for (const rawEdge of source.edges) {
            if (!rawEdge || typeof rawEdge !== "object" || Array.isArray(rawEdge)) {
                throw new Error("catalog edge must be an object")
            }
            const edge = rawEdge as Record<string, unknown>
            if (edge.assetSizeKind !== "fulfill") continue
            if (!Array.isArray(edge.archives)) throw new Error("catalog archives must be an array")
            for (const rawArchive of edge.archives) {
                if (!rawArchive || typeof rawArchive !== "object" || Array.isArray(rawArchive)) {
                    throw new Error("catalog archive must be an object")
                }
                const archive = rawArchive as Record<string, unknown>
                archives.push({
                    kind: edge.fromVersion === null ? "full" : "diff",
                    fromVersion: edge.fromVersion as string | null,
                    toVersion: edge.toVersion as string,
                    platform: edge.platform as "android",
                    layer: archive.layer as CdnCatalogInput["archives"][number]["layer"],
                    order: archive.order as number,
                    relativePath: archive.relativePath as string,
                    compressedBytes: archive.compressedBytes as number,
                    sha256: archive.sha256 as string,
                })
            }
        }
        const candidate = build({
            archives,
            installedBytes: source.installedBytes as number,
            entityListsRelativePath: source.entityListsRelativePath as string,
        })
        if (!canonicalJsonBuffer(candidate).equals(canonicalJsonBuffer(value))) {
            throw new Error("catalog does not match its canonical derived form")
        }
        return candidate
    } catch {
        throw releaseCatalogError("release catalog object failed strict validation")
    }
}

export function resolveCatalogProjectRoot(moduleDirectory: string): string {
    return path.resolve(moduleDirectory, "../../..")
}

export class CdnCatalogLoader {
    private readonly projectRoot: string
    private readonly env: ContentPathEnvironment
    private readonly localCdn: boolean
    private readonly dependencies: CatalogLoaderDependencies
    private catalog: CdnCatalog | null = null
    private initialLoad: Promise<CdnCatalog> | null = null
    private operationTail: Promise<void> | null = null

    constructor({
        projectRoot,
        env = process.env,
        localCdn = true,
        dependencies = {},
    }: CdnCatalogLoaderOptions) {
        this.projectRoot = path.resolve(projectRoot)
        this.env = env
        this.localCdn = localCdn
        this.dependencies = dependencies
    }

    load(): Promise<CdnCatalog> {
        if (this.catalog) return Promise.resolve(this.catalog)
        if (this.initialLoad) return this.initialLoad

        this.initialLoad = this.enqueueCandidate().finally(() => {
            this.initialLoad = null
        })
        return this.initialLoad
    }

    reload(): Promise<CdnCatalog> {
        return this.enqueueCandidate()
    }

    loadFromSnapshot(
        release: ContentCurrentReleaseSnapshot | null,
        paths?: ContentRuntimePaths,
    ): Promise<CdnCatalog> {
        return this.enqueueCandidate({ release, paths })
    }

    private enqueueCandidate(
        selection?: {
            readonly release: ContentCurrentReleaseSnapshot | null
            readonly paths?: ContentRuntimePaths
        },
    ): Promise<CdnCatalog> {
        const operation = this.operationTail
            ? this.operationTail.then(() => this.buildCandidate(selection))
            : this.buildCandidate(selection)
        const tail = operation.then(() => undefined, () => undefined)
        this.operationTail = tail
        void tail.then(() => {
            if (this.operationTail === tail) this.operationTail = null
        })
        return operation
    }

    private async buildCandidate(
        selection?: {
            readonly release: ContentCurrentReleaseSnapshot | null
            readonly paths?: ContentRuntimePaths
        },
    ): Promise<CdnCatalog> {
        const resolvePaths = this.dependencies.resolvePaths ?? resolveContentPaths
        const resolveRuntimePaths = this.dependencies.resolveRuntimePaths
            ?? resolveContentRuntimePaths
        const build = this.dependencies.build ?? buildCdnCatalog
        const validateRuntimeFiles = this.dependencies.validateRuntimeFiles
            ?? ((manifest, paths) => validateCdnRuntimeFiles(manifest, paths.cdnRoot))
        const paths = selection?.paths ?? (this.localCdn
            ? resolvePaths({ projectRoot: this.projectRoot, env: this.env })
            : resolveRuntimePaths({
                projectRoot: this.projectRoot,
                env: { ...this.env, CDN_DIR: undefined },
            }))
        const releaseCandidate = selection === undefined
            ? (this.dependencies.createStore
                ?? (resolved => new ContentObjectStore(resolved)))(paths)
                .readCurrentReleaseSnapshot()
            : selection.release
        const release: ContentCurrentReleaseSnapshot | null = isPromiseLike<
            ContentCurrentReleaseSnapshot | null
        >(releaseCandidate)
            ? await releaseCandidate
            : releaseCandidate
        if (release !== null) {
            const catalogObject = release.objects[release.manifest.catalog.object]
            if (catalogObject === undefined) {
                throw releaseCatalogError("release catalog object is missing")
            }
            const candidate = deepFreeze(parseReleaseCatalog(catalogObject, build))
            if (candidate.targetVersion !== release.manifest.assetVersion) {
                throw releaseCatalogError("release catalog target does not match assetVersion")
            }
            this.catalog = candidate
            return candidate
        }
        const runtimeManifestPath = path.join(
            paths.contentRuntimeDir,
            RUNTIME_MANIFEST_RELATIVE_PATH,
        )
        let runtimeManifestValue: unknown
        try {
            runtimeManifestValue = this.dependencies.readRuntimeManifest
                ? await this.dependencies.readRuntimeManifest(runtimeManifestPath)
                : await readRuntimeManifestFile(paths.contentRuntimeDir)
        } catch (error) {
            if (error instanceof CatalogLoaderError
                && (error.code === "RUNTIME_MANIFEST_READ"
                    || error.code === "RUNTIME_MANIFEST_SCHEMA")) {
                throw runtimeManifestError(
                    error.code,
                    error.code === "RUNTIME_MANIFEST_READ"
                        ? `cannot read ${RUNTIME_MANIFEST_RELATIVE_PATH}`
                        : `${RUNTIME_MANIFEST_RELATIVE_PATH} failed schema validation`,
                )
            }
            throw runtimeManifestError(
                "RUNTIME_MANIFEST_READ",
                `cannot read ${RUNTIME_MANIFEST_RELATIVE_PATH}`,
            )
        }
        let runtimeManifest: CdnRuntimeManifest
        try {
            runtimeManifest = parseCdnRuntimeManifest(runtimeManifestValue)
        } catch {
            throw runtimeManifestError(
                "RUNTIME_MANIFEST_SCHEMA",
                `${RUNTIME_MANIFEST_RELATIVE_PATH} failed schema validation`,
            )
        }
        const candidate = deepFreeze(build(runtimeManifest.catalogInput))
        if (this.localCdn) {
            if (!hasCdnRoot(paths)) {
                throw new Error("local CDN catalog requires resolved CDN paths")
            }
            await validateRuntimeFiles(runtimeManifest, paths)
        }
        this.catalog = candidate
        return candidate
    }

    get(): CdnCatalog {
        if (!this.catalog) {
            throw new CatalogLoaderError("CATALOG_NOT_LOADED", "CDN catalog has not been loaded")
        }
        return this.catalog
    }
}
