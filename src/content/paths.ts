import fs from "node:fs"
import path from "node:path"

import { resolveRuntimeDataPaths } from "../runtime/data-paths"

export interface ContentPathEnvironment {
    readonly [name: string]: string | undefined
    readonly CDN_DIR?: string
    readonly DATA_DIR?: string
    readonly CONTENT_DIR?: string
    readonly CONTENT_STORE_DIR?: string
    readonly CONTENT_STATE_DIR?: string
    readonly CONTENT_RUNTIME_DIR?: string
    readonly WDFP_DATABASE_DIR?: string
}

export type ContentPathLayout = "modern" | "legacy"

export interface ContentPaths {
    readonly layout: ContentPathLayout
    readonly cdnDir: string
    readonly cdnRoot: string
    /** Legacy object-store root. In modern layout this is a read-only probe candidate. */
    readonly contentRootDir: string
    readonly contentStoreDir: string
    readonly contentStateDir: string
    readonly contentRuntimeDir: string
}

export interface PathApi {
    readonly sep: string
    basename(filePath: string): string
    dirname(filePath: string): string
    isAbsolute(filePath: string): boolean
    join(...paths: string[]): string
    relative(from: string, to: string): string
    resolve(...paths: string[]): string
}

export interface PathFileSystem {
    existsSync(filePath: string): boolean
    realpathSync(filePath: string): string
    lstatSync?(filePath: string): { isSymbolicLink(): boolean }
}

export interface ResolvePathDependencies {
    readonly pathApi?: PathApi
    readonly fsApi?: PathFileSystem
}

export interface ResolveContentPathsOptions extends ResolvePathDependencies {
    readonly projectRoot: string
    readonly env?: ContentPathEnvironment
}

export interface ResolveContentRootDirOptions extends ResolvePathDependencies {
    readonly projectRoot: string
    readonly env?: ContentPathEnvironment
}

interface ConfiguredDataRoot {
    readonly value: string
    readonly sourceLabel?: "DATA_DIR" | "WDFP_DATABASE_DIR"
}

const defaultFsApi: PathFileSystem = {
    existsSync: filePath => fs.existsSync(filePath),
    realpathSync: filePath => fs.realpathSync(filePath),
    lstatSync: filePath => fs.lstatSync(filePath),
}

function isFullyQualifiedAbsolute(filePath: string, pathApi: PathApi): boolean {
    if (pathApi.sep !== "\\") return pathApi.isAbsolute(filePath)
    return /^[A-Za-z]:[\\/]/.test(filePath)
        || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(filePath)
}

function requireAbsoluteProjectRoot(projectRoot: string, pathApi: PathApi): string {
    const configuredRoot = projectRoot.trim()
    if (!configuredRoot || !isFullyQualifiedAbsolute(configuredRoot, pathApi)) {
        throw new Error("projectRoot must be a non-empty fully-qualified absolute path")
    }
    return pathApi.resolve(configuredRoot)
}

function isSameOrDescendant(parent: string, candidate: string, pathApi: PathApi): boolean {
    const relativePath = pathApi.relative(parent, candidate)
    return relativePath === ""
        || (!pathApi.isAbsolute(relativePath)
            && relativePath !== ".."
            && !relativePath.startsWith(`..${pathApi.sep}`))
}

function resolvePhysicalPath(
    filePath: string,
    pathApi: PathApi,
    fsApi: PathFileSystem,
    label = "path",
): string {
    const missingSegments: string[] = []
    let existingAncestor = filePath

    while (!fsApi.existsSync(existingAncestor)) {
        if (fsApi.lstatSync) {
            try {
                if (fsApi.lstatSync(existingAncestor).isSymbolicLink()) {
                    throw new Error(
                        `${label} contains a dangling symbolic link: ${existingAncestor}`,
                    )
                }
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code
                if (code !== "ENOENT" && code !== "ENOTDIR") throw error
            }
        }
        const parent = pathApi.dirname(existingAncestor)
        if (parent === existingAncestor) {
            throw new Error(`cannot find an existing ancestor for ${filePath}`)
        }
        missingSegments.unshift(pathApi.basename(existingAncestor))
        existingAncestor = parent
    }

    return pathApi.resolve(fsApi.realpathSync(existingAncestor), ...missingSegments)
}

function resolveConfiguredPath(
    value: string,
    projectRoot: string,
    variableName: string,
    pathApi: PathApi,
    fsApi: PathFileSystem,
): string {
    const configuredPath = value.trim()
    if (!configuredPath) throw new Error(`${variableName} must not be empty`)

    if (pathApi.sep === "\\" && /^[\\/](?![\\/])/.test(configuredPath)) {
        throw new Error(`${variableName} must not use a root-relative Windows path; use a fully-qualified absolute path`)
    }

    if (isFullyQualifiedAbsolute(configuredPath, pathApi)) {
        return pathApi.resolve(configuredPath)
    }
    if (pathApi.isAbsolute(configuredPath)
        || (pathApi.sep === "\\" && /^[A-Za-z]:/.test(configuredPath))) {
        throw new Error(`${variableName} must use a fully-qualified absolute path`)
    }

    const resolvedPath = pathApi.resolve(projectRoot, configuredPath)
    if (!isSameOrDescendant(projectRoot, resolvedPath, pathApi)) {
        throw new Error(`${variableName} resolves outside projectRoot; use an absolute path for external locations`)
    }

    const physicalRoot = resolvePhysicalPath(projectRoot, pathApi, fsApi, "projectRoot")
    const physicalPath = resolvePhysicalPath(resolvedPath, pathApi, fsApi, variableName)
    if (!isSameOrDescendant(physicalRoot, physicalPath, pathApi)) {
        throw new Error(`${variableName} resolves physically outside projectRoot; use an absolute path for external locations`)
    }
    return resolvedPath
}

function resolveCdnDir(
    cdnDir: string,
    projectRoot: string,
    pathApi: PathApi,
    fsApi: PathFileSystem,
): string {
    const root = requireAbsoluteProjectRoot(projectRoot, pathApi)
    const resolvedCdnDir = resolveConfiguredPath(cdnDir, root, "CDN_DIR", pathApi, fsApi)
    if (pathApi.basename(resolvedCdnDir).toLowerCase() === "cn") {
        throw new Error("CDN_DIR must point to the parent directory; remove the trailing cn segment")
    }
    return resolvedCdnDir
}

function selectConfiguredDataRoot(env: ContentPathEnvironment): ConfiguredDataRoot {
    if (env.DATA_DIR) return { value: env.DATA_DIR, sourceLabel: "DATA_DIR" }
    if (env.WDFP_DATABASE_DIR) {
        return { value: env.WDFP_DATABASE_DIR, sourceLabel: "WDFP_DATABASE_DIR" }
    }
    return { value: ".database" }
}

export function resolveCnCdnRoot(
    cdnDir: string,
    projectRoot: string,
    dependencies: ResolvePathDependencies = {},
): string {
    const pathApi = dependencies.pathApi ?? path
    const fsApi = dependencies.fsApi ?? defaultFsApi
    return pathApi.join(resolveCdnDir(cdnDir, projectRoot, pathApi, fsApi), "cn")
}

export function resolveContentRootDir({
    projectRoot,
    env = process.env,
    pathApi = path,
    fsApi = defaultFsApi,
}: ResolveContentRootDirOptions): string {
    const root = requireAbsoluteProjectRoot(projectRoot, pathApi)
    return resolveConfiguredPath(
        env.CONTENT_DIR ?? ".content",
        root,
        "CONTENT_DIR",
        pathApi,
        fsApi,
    )
}

function assertIsolatedContentPaths(
    entries: ReadonlyArray<readonly [name: string, filePath: string]>,
    pathApi: PathApi,
    fsApi: PathFileSystem,
): void {
    const physicalEntries = entries.map(([name, filePath]) => (
        [name, resolvePhysicalPath(filePath, pathApi, fsApi, name)] as const
    ))

    for (let leftIndex = 0; leftIndex < physicalEntries.length; leftIndex++) {
        const [leftName, leftPath] = physicalEntries[leftIndex]
        for (let rightIndex = leftIndex + 1; rightIndex < physicalEntries.length; rightIndex++) {
            const [rightName, rightPath] = physicalEntries[rightIndex]
            if (isSameOrDescendant(leftPath, rightPath, pathApi)
                || isSameOrDescendant(rightPath, leftPath, pathApi)) {
                throw new Error(`${leftName} and ${rightName} must not be equal or nested`)
            }
        }
    }
}

export function resolveContentPaths({
    projectRoot,
    env = process.env,
    pathApi = path,
    fsApi = defaultFsApi,
}: ResolveContentPathsOptions): ContentPaths {
    const root = requireAbsoluteProjectRoot(projectRoot, pathApi)
    const hasLegacyRoot = env.CONTENT_DIR !== undefined
    const splitVariables = ["CONTENT_STORE_DIR", "CONTENT_STATE_DIR"] as const
    for (const variableName of splitVariables) {
        if (hasLegacyRoot && env[variableName] !== undefined) {
            throw new Error(`CONTENT_DIR and ${variableName} cannot be configured together`)
        }
    }

    const layout: ContentPathLayout = hasLegacyRoot ? "legacy" : "modern"
    const cdnDir = resolveCdnDir(env.CDN_DIR ?? ".cdn", root, pathApi, fsApi)
    const contentRootDir = resolveConfiguredPath(
        env.CONTENT_DIR ?? ".content",
        root,
        "CONTENT_DIR",
        pathApi,
        fsApi,
    )
    const contentRuntimeDir = resolveConfiguredPath(
        env.CONTENT_RUNTIME_DIR ?? "assets",
        root,
        "CONTENT_RUNTIME_DIR",
        pathApi,
        fsApi,
    )
    let contentStoreDir = contentRootDir
    let contentStateDir = contentRootDir
    if (layout === "modern") {
        const configuredDataRoot = selectConfiguredDataRoot(env)
        const absoluteDataDir = configuredDataRoot.sourceLabel !== undefined
            && isFullyQualifiedAbsolute(configuredDataRoot.value, pathApi)
        const dataDir = absoluteDataDir
            ? resolveRuntimeDataPaths(env, root, pathApi).dataDir
            : configuredDataRoot.value
        const resolveGeneratedDataPath = (
            segments: readonly string[],
            fallbackLabel: string,
        ): string => absoluteDataDir
            ? pathApi.join(dataDir, ...segments)
            : resolveConfiguredPath(
                pathApi.join(dataDir, ...segments),
                root,
                configuredDataRoot.sourceLabel ?? fallbackLabel,
                pathApi,
                fsApi,
            )

        contentStoreDir = env.CONTENT_STORE_DIR === undefined
            ? resolveGeneratedDataPath(["content", "store"], "CONTENT_STORE_DIR")
            : resolveConfiguredPath(
                env.CONTENT_STORE_DIR,
                root,
                "CONTENT_STORE_DIR",
                pathApi,
                fsApi,
            )
        contentStateDir = env.CONTENT_STATE_DIR === undefined
            ? resolveGeneratedDataPath(["state", "content"], "CONTENT_STATE_DIR")
            : resolveConfiguredPath(
                env.CONTENT_STATE_DIR,
                root,
                "CONTENT_STATE_DIR",
                pathApi,
                fsApi,
            )
    }

    const paths: ContentPaths = {
        layout,
        cdnDir,
        cdnRoot: pathApi.join(cdnDir, "cn"),
        contentRootDir,
        contentStoreDir,
        contentStateDir,
        contentRuntimeDir,
    }

    const isolatedPaths: ReadonlyArray<readonly [name: string, filePath: string]> = layout === "legacy"
        ? [
            ["CDN_DIR", paths.cdnDir],
            ["CONTENT_DIR", paths.contentRootDir],
            ["CONTENT_RUNTIME_DIR", paths.contentRuntimeDir],
        ]
        : [
            ["CDN_DIR", paths.cdnDir],
            ["CONTENT_DIR", paths.contentRootDir],
            ["CONTENT_STORE_DIR", paths.contentStoreDir],
            ["CONTENT_STATE_DIR", paths.contentStateDir],
            ["CONTENT_RUNTIME_DIR", paths.contentRuntimeDir],
        ]
    assertIsolatedContentPaths(isolatedPaths, pathApi, fsApi)
    return paths
}
