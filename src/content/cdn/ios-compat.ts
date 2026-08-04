// iOS 实体表/归档目录解析与 iOS 目录视图构建（ios_medium.csv、archive-ios-full/diff）
// 由"灰"制作，基于 DontBeAlarmed/startpoint-cn@dev 提交 11d3bcf9 的 iOS 修复补丁包
// （见补丁包内 iOS修复部署说明.txt）。
// 社区适配：缺失 iOS edge 时回落原 edge 而非抛错（见 replacePlatformArchives）。
import fs from "node:fs"
import path from "node:path"

import type { CatalogArchive, CatalogEdge, CdnCatalog } from "./types"

const IOS_FULL_DIRECTORY = "archive-ios-full"
const IOS_DIFF_DIRECTORY = "archive-ios-diff"
const ARCHIVE_VERSION_PATTERN = /(?:pinball|asset)-(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)-\d+-/

function archive(relativePath: string, compressedBytes: number, order: number): CatalogArchive {
    return Object.freeze({
        relativePath,
        compressedBytes,
        sha256: "",
        layer: "platform" as const,
        order,
    })
}

function readZipArchives(cdnRoot: string, directory: string): ReadonlyArray<CatalogArchive> {
    const absoluteDirectory = path.join(cdnRoot, directory)
    return fs.readdirSync(absoluteDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry, index) => archive(
            `${directory}/${entry.name}`,
            fs.statSync(path.join(absoluteDirectory, entry.name)).size,
            index + 1,
        ))
}

function matchesDiffEdge(relativePath: string, fromVersion: string, toVersion: string): boolean {
    const match = path.posix.basename(relativePath).match(ARCHIVE_VERSION_PATTERN)
    return match !== null && match[1] === fromVersion && match[2] === toVersion
}

function replacePlatformArchives(
    edge: CatalogEdge,
    iosFull: ReadonlyArray<CatalogArchive>,
    iosDiff: ReadonlyArray<CatalogArchive>,
): CatalogEdge {
    const shared = edge.archives.filter(candidate => candidate.layer !== "platform")
    const platform = edge.fromVersion === null
        ? iosFull
        : iosDiff.filter(candidate => matchesDiffEdge(
            candidate.relativePath,
            edge.fromVersion as string,
            edge.toVersion,
        ))
    if (platform.length === 0) {
        // 缺失 iOS edge 时不抛错：记录并回落原 edge（Android platform 层），避免 get_path/version_info 500。
        // 正常部署仍应提供完整 archive-ios-*（ios diff 可由 android diff 复制补齐）。
        console.log(`[IOS-COMPAT] skip missing iOS edge ${String(edge.fromVersion)} -> ${edge.toVersion}`)
        return edge
    }
    return Object.freeze({ ...edge, archives: Object.freeze([...shared, ...platform]) })
}

/**
 * Build an iOS view of the pinned Android catalog without changing upstream's
 * Android planner or snapshot model. Shared/common archives stay pinned to the
 * snapshot; only the platform layer is replaced with archive-ios-* files.
 */
export function buildIosCompatibleCatalog(catalog: CdnCatalog, cdnRoot: string): CdnCatalog {
    const iosFull = readZipArchives(cdnRoot, IOS_FULL_DIRECTORY)
    const iosDiff = readZipArchives(cdnRoot, IOS_DIFF_DIRECTORY)
    const edges = catalog.edges.map(edge => replacePlatformArchives(edge, iosFull, iosDiff))
    return Object.freeze({ ...catalog, edges: Object.freeze(edges) })
}

export function resolveIosEntityList(catalog: CdnCatalog, cdnRoot: string): string {
    const androidPath = catalog.entityListsRelativePath
    const expected = androidPath.replace(/android_medium\.csv$/i, "ios_medium.csv")
    if (expected !== androidPath && fs.existsSync(path.join(cdnRoot, ...expected.split("/")))) {
        return expected
    }

    const directory = path.posix.dirname(androidPath)
    const absoluteDirectory = path.join(cdnRoot, ...directory.split("/"))
    const candidates = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && /-ios_medium\.csv$/i.test(entry.name))
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right))
    if (candidates.length !== 1) {
        throw new Error(`expected exactly one iOS entity list beside ${androidPath}`)
    }
    return `${directory}/${candidates[0]}`
}

export function isIosAssetDevice(device: string | undefined): boolean {
    const normalized = device?.toLowerCase()
    return normalized === "1" || normalized === "ios"
}

export function isSupportedCnAssetDevice(device: string | undefined): boolean {
    if (device === undefined) return true
    const normalized = device.toLowerCase()
    return normalized === "1"
        || normalized === "2"
        || normalized === "ios"
        || normalized === "android"
}

export function isIosArchiveRelativePath(relativePath: string): boolean {
    return relativePath.startsWith(`${IOS_FULL_DIRECTORY}/`)
        || relativePath.startsWith(`${IOS_DIFF_DIRECTORY}/`)
}
