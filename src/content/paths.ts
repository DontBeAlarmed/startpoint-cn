import path from "node:path"

export interface ContentPathEnvironment {
    readonly [name: string]: string | undefined
    CDN_DIR?: string
    CONTENT_STORE_DIR?: string
    CONTENT_STATE_DIR?: string
    CONTENT_RUNTIME_DIR?: string
}

export interface ContentPaths {
    cdnRoot: string
    contentStoreDir: string
    contentStateDir: string
    contentRuntimeDir: string
}

export interface ResolveContentPathsOptions {
    projectRoot: string
    env?: ContentPathEnvironment
}

function requireAbsoluteProjectRoot(projectRoot: string): string {
    const normalizedRoot = path.normalize(projectRoot.trim())
    if (!projectRoot.trim() || !path.isAbsolute(normalizedRoot)) {
        throw new Error("projectRoot must be a non-empty absolute path")
    }
    return normalizedRoot
}

function resolveConfiguredPath(value: string, projectRoot: string, variableName: string): string {
    const configuredPath = value.trim()
    if (!configuredPath) throw new Error(`${variableName} must not be empty`)

    if (path.isAbsolute(configuredPath)) return path.resolve(configuredPath)

    const resolvedPath = path.resolve(projectRoot, configuredPath)
    const relativePath = path.relative(projectRoot, resolvedPath)
    if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        throw new Error(`${variableName} resolves outside projectRoot; use an absolute path for external locations`)
    }
    return resolvedPath
}

export function resolveCnCdnRoot(cdnDir: string, projectRoot: string): string {
    const root = requireAbsoluteProjectRoot(projectRoot)
    const resolvedCdnDir = resolveConfiguredPath(cdnDir, root, "CDN_DIR")
    return path.basename(resolvedCdnDir) === "cn"
        ? resolvedCdnDir
        : path.join(resolvedCdnDir, "cn")
}

export function resolveContentPaths({
    projectRoot,
    env = process.env,
}: ResolveContentPathsOptions): ContentPaths {
    const root = requireAbsoluteProjectRoot(projectRoot)
    return {
        cdnRoot: resolveCnCdnRoot(env.CDN_DIR ?? ".cdn", root),
        contentStoreDir: resolveConfiguredPath(
            env.CONTENT_STORE_DIR ?? ".content/store",
            root,
            "CONTENT_STORE_DIR",
        ),
        contentStateDir: resolveConfiguredPath(
            env.CONTENT_STATE_DIR ?? ".content/state",
            root,
            "CONTENT_STATE_DIR",
        ),
        contentRuntimeDir: resolveConfiguredPath(
            env.CONTENT_RUNTIME_DIR ?? ".content/runtime",
            root,
            "CONTENT_RUNTIME_DIR",
        ),
    }
}
