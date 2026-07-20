import fs from "node:fs"
import path from "node:path"

import {
    resolveContentPaths,
    type ContentPathEnvironment,
    type ContentPaths,
} from "../paths"
import {
    buildCdnCatalog,
    scanCdnCatalogInput,
    type ScanCdnCatalogDependencies,
} from "./catalog-builder"
import type { CdnCatalog, CdnCatalogInput } from "./types"

export type CatalogLoaderErrorCode =
    | "CATALOG_NOT_LOADED"
    | "PATCH_MANIFEST_READ"
    | "PATCH_MANIFEST_SCHEMA"
    | "PATCH_CATALOG_MISMATCH"

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
    readonly scan?: (
        paths: ContentPaths,
        dependencies?: ScanCdnCatalogDependencies,
    ) => Promise<CdnCatalogInput>
    readonly build?: (input: CdnCatalogInput) => CdnCatalog
    readonly readPatchManifest?: (manifestPath: string) => Promise<unknown>
    readonly scanDependencies?: ScanCdnCatalogDependencies
}

export interface CdnCatalogLoaderOptions {
    readonly projectRoot: string
    readonly env?: ContentPathEnvironment
    readonly dependencies?: CatalogLoaderDependencies
}

function deepFreeze<T>(value: T): T {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    return Object.freeze(value)
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

export function resolveCatalogProjectRoot(moduleDirectory: string): string {
    return path.resolve(moduleDirectory, "../../..")
}

export class CdnCatalogLoader {
    private readonly projectRoot: string
    private readonly env: ContentPathEnvironment
    private readonly dependencies: CatalogLoaderDependencies
    private catalog: CdnCatalog | null = null
    private initialLoad: Promise<CdnCatalog> | null = null
    private operationTail: Promise<void> | null = null

    constructor({ projectRoot, env = process.env, dependencies = {} }: CdnCatalogLoaderOptions) {
        this.projectRoot = path.resolve(projectRoot)
        this.env = env
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

    private enqueueCandidate(): Promise<CdnCatalog> {
        const operation = this.operationTail
            ? this.operationTail.then(() => this.buildCandidate())
            : this.buildCandidate()
        const tail = operation.then(() => undefined, () => undefined)
        this.operationTail = tail
        void tail.then(() => {
            if (this.operationTail === tail) this.operationTail = null
        })
        return operation
    }

    private async buildCandidate(): Promise<CdnCatalog> {
        const resolvePaths = this.dependencies.resolvePaths ?? resolveContentPaths
        const scan = this.dependencies.scan ?? scanCdnCatalogInput
        const build = this.dependencies.build ?? buildCdnCatalog
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
        const paths = resolvePaths({ projectRoot: this.projectRoot, env: this.env })
        const input = await scan(paths, this.dependencies.scanDependencies)
        const candidate = deepFreeze(build(input))
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
