import path from "node:path"

import { BUNDLED_CDN_CATALOG_VERSION } from "../constants"
import {
    resolveContentPaths,
    type ContentPathEnvironment,
    type ContentPaths,
} from "../paths"
import {
    materializeContentCatalogInput,
    scanContentTarget,
    type ContentTargetScan,
} from "../sync/scanner"
import { buildCdnCatalog } from "./catalog-builder"
import type { CdnCatalog, CdnCatalogInput } from "./types"

export interface PatchCheckPackageSummary {
    readonly targetVersion: string
    readonly archiveCount: number
    readonly bytes: number
}

export interface PatchCheckResult {
    readonly schemaVersion: 1
    readonly status: "valid"
    readonly baselineVersion: string
    readonly targetVersion: string
    readonly patchCount: number
    readonly patchArchiveCount: number
    readonly patchBytes: number
    readonly patches: readonly PatchCheckPackageSummary[]
}

export interface PatchCheckOptions {
    readonly projectRoot: string
    readonly env?: ContentPathEnvironment
}

export interface PatchCheckDependencies {
    readonly resolvePaths?: typeof resolveContentPaths
    readonly scanTarget?: (paths: ContentPaths) => Promise<ContentTargetScan>
    readonly materializeCatalog?: (
        scan: ContentTargetScan,
    ) => Promise<CdnCatalogInput>
    readonly buildCatalog?: (input: CdnCatalogInput) => CdnCatalog
}

export interface PatchCheckCliDependencies {
    readonly projectRoot?: string
    readonly env?: ContentPathEnvironment
    readonly runCheck?: (
        options: PatchCheckOptions,
    ) => Promise<PatchCheckResult>
    readonly stdout?: Pick<NodeJS.WriteStream, "write">
    readonly stderr?: Pick<NodeJS.WriteStream, "write">
    readonly setExitCode?: (code: number) => void
}

export function summarizePatchCheck(
    scan: ContentTargetScan,
    catalog: CdnCatalog,
): PatchCheckResult {
    const packages = new Map<string, { archiveCount: number; bytes: number }>()
    for (const manifest of scan.patchManifests) {
        packages.set(manifest.targetVersion, { archiveCount: 0, bytes: 0 })
    }
    for (const archive of scan.archives) {
        if (archive.source.kind !== "patch") continue
        const summary = packages.get(archive.source.targetVersion)
            ?? { archiveCount: 0, bytes: 0 }
        summary.archiveCount += 1
        summary.bytes += archive.compressedBytes
        packages.set(archive.source.targetVersion, summary)
    }
    const patches = [...packages.entries()]
        .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
        .map(([targetVersion, summary]) => ({ targetVersion, ...summary }))
    return Object.freeze({
        schemaVersion: 1,
        status: "valid",
        baselineVersion: BUNDLED_CDN_CATALOG_VERSION,
        targetVersion: catalog.targetVersion,
        patchCount: patches.length,
        patchArchiveCount: patches.reduce((total, item) => total + item.archiveCount, 0),
        patchBytes: patches.reduce((total, item) => total + item.bytes, 0),
        patches: Object.freeze(patches.map(item => Object.freeze(item))),
    })
}

export async function runPatchCheck(
    options: PatchCheckOptions,
    dependencies: PatchCheckDependencies = {},
): Promise<PatchCheckResult> {
    if (!options.projectRoot || !path.isAbsolute(options.projectRoot)) {
        throw new TypeError("projectRoot must be an absolute path")
    }
    const projectRoot = path.resolve(options.projectRoot)
    const resolvePaths = dependencies.resolvePaths ?? resolveContentPaths
    const paths = resolvePaths({ projectRoot, env: options.env ?? process.env })
    const scanTarget = dependencies.scanTarget ?? scanContentTarget
    const materializeCatalog = dependencies.materializeCatalog
        ?? materializeContentCatalogInput
    const buildCatalog = dependencies.buildCatalog ?? buildCdnCatalog
    const scan = await scanTarget(paths)
    const catalog = buildCatalog(await materializeCatalog(scan))
    return summarizePatchCheck(scan, catalog)
}

function sanitizeErrorMessage(message: string, projectRoot: string): string {
    const projectPathMarker = "\u0000PROJECT_PATH\u0000"
    const escapedProjectRoot = projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const projectPathPattern = new RegExp(
        `${escapedProjectRoot}(?:[\\\\/][^\\s:：,，;；\"']+)?`,
        "g",
    )
    return message.replace(projectPathPattern, projectPathMarker)
        .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\|\/)[^"'\r\n]*\1/g, "$1<PATH>$1")
        .replace(/\\\\[^\s:：,，;；"']+/g, "<PATH>")
        .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s:：,，;；"']+/g, "<PATH>")
        .split(projectPathMarker).join("<PROJECT_ROOT>/<PATH>")
}

export async function runPatchCheckCli(
    argv: readonly string[],
    dependencies: PatchCheckCliDependencies = {},
): Promise<number> {
    const projectRoot = path.resolve(dependencies.projectRoot ?? path.resolve(__dirname, "../../.."))
    const stdout = dependencies.stdout ?? process.stdout
    const stderr = dependencies.stderr ?? process.stderr
    const setExitCode = dependencies.setExitCode ?? (code => { process.exitCode = code })
    try {
        if (argv.length > 0) {
            throw new Error(`CDN_PATCH_CHECK_UNKNOWN_ARGUMENT: 未知参数：${argv[0]}`)
        }
        const result = await (dependencies.runCheck ?? runPatchCheck)({
            projectRoot,
            env: dependencies.env ?? process.env,
        })
        stdout.write(`${JSON.stringify(result)}\n`)
        setExitCode(0)
        return 0
    } catch (error) {
        const message = error instanceof Error ? error.message : "补丁校验失败"
        const prefixed = message.startsWith("CDN_PATCH_CHECK_UNKNOWN_ARGUMENT:")
        const code = prefixed ? "CDN_PATCH_CHECK_UNKNOWN_ARGUMENT" : "CDN_PATCH_CHECK_FAILED"
        const detail = prefixed ? message.slice("CDN_PATCH_CHECK_UNKNOWN_ARGUMENT:".length).trim() : message
        stderr.write(`错误 [${code}]：${sanitizeErrorMessage(detail, projectRoot)}\n`)
        setExitCode(1)
        return 1
    }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
    return runPatchCheckCli(argv)
}
