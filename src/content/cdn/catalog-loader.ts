import fs from "node:fs"
import path from "node:path"

import { BUNDLED_CDN_CATALOG_VERSION } from "../constants"
import {
    resolveContentPaths,
    resolveContentRootDir,
    type ContentPathEnvironment,
    type ContentPaths,
} from "../paths"
import { deepFreeze } from "../deep-freeze"
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
    | "PATCH_MANIFEST_READ"
    | "PATCH_MANIFEST_SCHEMA"
    | "PATCH_CATALOG_MISMATCH"
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
    readonly build?: (input: CdnCatalogInput) => CdnCatalog
    readonly readRuntimeManifest?: (manifestPath: string) => Promise<unknown>
    readonly validateRuntimeFiles?: (
        manifest: CdnRuntimeManifest,
        paths: ContentPaths,
    ) => Promise<void>
    readonly readPatchManifest?: (manifestPath: string) => Promise<unknown>
    readonly createStore?: (
        paths: Pick<ContentPaths, "contentRootDir">,
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

interface PatchManifestEntry {
    readonly id: string
    readonly type: "patch" | "mod"
    readonly name: string
    readonly version: string
    readonly depends_on: string
    readonly enabled: boolean
    readonly archive?: string
    readonly archive_size?: number
}

interface PatchManifest {
    readonly cdn_version: string
    readonly patches: ReadonlyArray<PatchManifestEntry>
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const RUNTIME_MANIFEST_RELATIVE_PATH = (
    `assets/cdn/catalog-cn-${BUNDLED_CDN_CATALOG_VERSION}.json`
)

function runtimeManifestError(
    code: "RUNTIME_MANIFEST_READ" | "RUNTIME_MANIFEST_SCHEMA",
    message: string,
): CatalogLoaderError {
    return new CatalogLoaderError(code, message)
}

async function readRuntimeManifestFile(manifestPath: string): Promise<unknown> {
    let content: string
    try {
        content = await fs.promises.readFile(manifestPath, "utf8")
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

function schemaError(message: string, cause?: unknown): CatalogLoaderError {
    return new CatalogLoaderError(
        "PATCH_MANIFEST_SCHEMA",
        message,
        cause,
    )
}

function parsePatchManifest(value: unknown): PatchManifest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw schemaError("patch manifest must be an object")
    }
    const candidate = value as Record<string, unknown>
    if (typeof candidate.cdn_version !== "string" || !VERSION_PATTERN.test(candidate.cdn_version)) {
        throw schemaError("patch manifest cdn_version must be a semantic version string")
    }
    if (!Array.isArray(candidate.patches)) {
        throw schemaError("patch manifest patches must be an array")
    }

    const patches = candidate.patches.map((entry, index): PatchManifestEntry => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw schemaError(`patches[${index}] must be an object`)
        }
        const patch = entry as Record<string, unknown>
        if (typeof patch.id !== "string" || patch.id.length === 0
            || typeof patch.name !== "string"
            || (patch.type !== "patch" && patch.type !== "mod")
            || typeof patch.version !== "string" || !VERSION_PATTERN.test(patch.version)
            || typeof patch.depends_on !== "string" || !VERSION_PATTERN.test(patch.depends_on)
            || typeof patch.enabled !== "boolean") {
            throw schemaError(`patches[${index}] has invalid required fields`)
        }
        if (patch.archive !== undefined && typeof patch.archive !== "string") {
            throw schemaError(`patches[${index}].archive must be a string`)
        }
        if (patch.archive_size !== undefined
            && (!Number.isSafeInteger(patch.archive_size) || (patch.archive_size as number) < 0)) {
            throw schemaError(`patches[${index}].archive_size must be a non-negative safe integer`)
        }
        if (patch.enabled && patch.type === "patch"
            && (typeof patch.archive !== "string" || patch.archive.length === 0
                || !Number.isSafeInteger(patch.archive_size))) {
            throw schemaError(`enabled patch ${patch.id} must declare archive and archive_size`)
        }
        return patch as unknown as PatchManifestEntry
    })
    const patchIds = new Set<string>()
    for (const patch of patches) {
        if (patchIds.has(patch.id)) throw schemaError(`duplicate patch id ${patch.id}`)
        patchIds.add(patch.id)
    }
    return { cdn_version: candidate.cdn_version, patches }
}

function validateEnabledPatches(catalog: CdnCatalog, manifest: PatchManifest): void {
    for (const patch of manifest.patches) {
        if (!patch.enabled || patch.type !== "patch") continue
        const edge = catalog.edges.find(candidate => (
            candidate.fromVersion === patch.depends_on
            && candidate.toVersion === patch.version
            && candidate.platform === "android"
            && candidate.assetSizeKind === "fulfill"
        ))
        if (!edge) {
            throw new CatalogLoaderError(
                "PATCH_CATALOG_MISMATCH",
                `enabled patch ${patch.id} is missing edge ${patch.depends_on} -> ${patch.version}`,
            )
        }
        const namedArchives = edge.archives.filter(archive => (
            path.basename(archive.relativePath) === patch.archive
        ))
        if (namedArchives.length === 0) {
            throw new CatalogLoaderError(
                "PATCH_CATALOG_MISMATCH",
                `enabled patch ${patch.id} archive basename ${patch.archive} is absent from its catalog edge`,
            )
        }
        if (!namedArchives.some(archive => archive.compressedBytes === patch.archive_size)) {
            throw new CatalogLoaderError(
                "PATCH_CATALOG_MISMATCH",
                `enabled patch ${patch.id} archive size ${patch.archive_size} does not match its catalog edge`,
            )
        }
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

    loadFromSnapshot(release: ContentCurrentReleaseSnapshot | null): Promise<CdnCatalog> {
        return this.enqueueCandidate({ release })
    }

    private enqueueCandidate(
        selection?: { readonly release: ContentCurrentReleaseSnapshot | null },
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
        selection?: { readonly release: ContentCurrentReleaseSnapshot | null },
    ): Promise<CdnCatalog> {
        const resolvePaths = this.dependencies.resolvePaths ?? resolveContentPaths
        const build = this.dependencies.build ?? buildCdnCatalog
        const readRuntimeManifest = this.dependencies.readRuntimeManifest ?? readRuntimeManifestFile
        const validateRuntimeFiles = this.dependencies.validateRuntimeFiles
            ?? ((manifest, paths) => validateCdnRuntimeFiles(manifest, paths.cdnRoot))
        const readPatchManifest = this.dependencies.readPatchManifest ?? (async manifestPath => {
            let content: string
            try {
                content = await fs.promises.readFile(manifestPath, "utf8")
            } catch (error) {
                throw new CatalogLoaderError(
                    "PATCH_MANIFEST_READ",
                    `cannot read patch manifest ${manifestPath}`,
                    error,
                )
            }
            try {
                return JSON.parse(content)
            } catch (error) {
                throw schemaError(`patch manifest ${manifestPath} is not valid JSON`, error)
            }
        })
        const paths = this.localCdn
            ? resolvePaths({ projectRoot: this.projectRoot, env: this.env })
            : null
        const storePaths = paths ?? {
            contentRootDir: resolveContentRootDir({
                projectRoot: this.projectRoot,
                env: this.env,
            }),
        }
        const releaseCandidate = selection === undefined
            ? (this.dependencies.createStore
                ?? (resolved => new ContentObjectStore(resolved)))(storePaths)
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
        const runtimeManifestPath = path.join(this.projectRoot, RUNTIME_MANIFEST_RELATIVE_PATH)
        let runtimeManifestValue: unknown
        try {
            runtimeManifestValue = await readRuntimeManifest(runtimeManifestPath)
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
        if (paths !== null) await validateRuntimeFiles(runtimeManifest, paths)
        const manifestPath = path.join(this.projectRoot, "assets", "asset-patch", "manifest.json")
        const manifest = parsePatchManifest(await readPatchManifest(manifestPath))
        validateEnabledPatches(candidate, manifest)
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
