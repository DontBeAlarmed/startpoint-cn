import fs from "node:fs"
import path from "node:path"

export interface ContentPathEnvironment {
    readonly [name: string]: string | undefined
    readonly CDN_DIR?: string
    readonly CONTENT_DIR?: string
    readonly CONTENT_STORE_DIR?: string
    readonly CONTENT_STATE_DIR?: string
    readonly CONTENT_RUNTIME_DIR?: string
}

export interface ContentPaths {
    readonly cdnDir: string
    readonly cdnRoot: string
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

export function resolveCnCdnRoot(
    cdnDir: string,
    projectRoot: string,
    dependencies: ResolvePathDependencies = {},
): string {
    const pathApi = dependencies.pathApi ?? path
    const fsApi = dependencies.fsApi ?? defaultFsApi
    return pathApi.join(resolveCdnDir(cdnDir, projectRoot, pathApi, fsApi), "cn")
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
    const cdnDir = resolveCdnDir(env.CDN_DIR ?? ".cdn", root, pathApi, fsApi)
    const paths: ContentPaths = {
        cdnDir,
        cdnRoot: pathApi.join(cdnDir, "cn"),
        contentRootDir: resolveConfiguredPath(
            env.CONTENT_DIR ?? ".content",
            root,
            "CONTENT_DIR",
            pathApi,
            fsApi,
        ),
        contentStoreDir: resolveConfiguredPath(
            env.CONTENT_STORE_DIR ?? ".content/store",
            root,
            "CONTENT_STORE_DIR",
            pathApi,
            fsApi,
        ),
        contentStateDir: resolveConfiguredPath(
            env.CONTENT_STATE_DIR ?? ".content/state",
            root,
            "CONTENT_STATE_DIR",
            pathApi,
            fsApi,
        ),
        contentRuntimeDir: resolveConfiguredPath(
            env.CONTENT_RUNTIME_DIR ?? ".content/runtime",
            root,
            "CONTENT_RUNTIME_DIR",
            pathApi,
            fsApi,
        ),
    }

    assertIsolatedContentPaths([
        ["CDN_DIR", paths.cdnDir],
        ["CONTENT_STORE_DIR", paths.contentStoreDir],
        ["CONTENT_STATE_DIR", paths.contentStateDir],
        ["CONTENT_RUNTIME_DIR", paths.contentRuntimeDir],
    ], pathApi, fsApi)
    assertIsolatedContentPaths([
        ["CDN_DIR", paths.cdnDir],
        ["CONTENT_DIR", paths.contentRootDir],
    ], pathApi, fsApi)
    if (env.CONTENT_DIR !== undefined) {
        assertIsolatedContentPaths([
            ["CONTENT_DIR", paths.contentRootDir],
            ["CONTENT_STORE_DIR", paths.contentStoreDir],
            ["CONTENT_STATE_DIR", paths.contentStateDir],
            ["CONTENT_RUNTIME_DIR", paths.contentRuntimeDir],
        ], pathApi, fsApi)
    }
    return paths
}
