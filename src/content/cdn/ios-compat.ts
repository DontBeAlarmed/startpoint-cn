// iOS 目录视图构建与冻结缓存（ios_medium.csv、archive-ios-full/diff）
// 由"灰"制作，基于 DontBeAlarmed/startpoint-cn@dev 提交 11d3bcf9。
// 社区适配：
//  - 缺失 iOS edge、实体表或目录整体缺失 → iOS 视图标记为明确"不可用"（503），
//    不回退 Android platform 归档，错误严格限制在 iOS 请求范围（不影响 Android）。
//  - iOS 目录在启动/首次使用扫描一次并冻结（模块级缓存），不在每次请求中重扫磁盘。
import fs from "node:fs"
import path from "node:path"

import type { ContentSnapshot } from "../runtime/content-snapshot"
import type { CatalogArchive, CatalogEdge, CdnCatalog } from "./types"

const IOS_FULL_DIRECTORY = "archive-ios-full"
const IOS_DIFF_DIRECTORY = "archive-ios-diff"
const ARCHIVE_VERSION_PATTERN = /(?:pinball|asset)-(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)-\d+-/
const ENTITY_LIST_HEADER = "path,version,size,hash,layer"
const EMPTY_ALLOWLIST: ReadonlyMap<string, number> = Object.freeze(new Map<string, number>())

export type IosCompatState =
    | {
        readonly kind: "ready"
        readonly catalog: CdnCatalog
        readonly installedBytes: number
    }
    | {
        readonly kind: "unavailable"
        readonly reason: string
    }

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
    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            // iOS 目录缺失：返回空列表（整体可用性由 prepareIosCompat 判定，不在此抛错）。
            return []
        }
        throw error
    }
    return entries
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
): CatalogEdge | null {
    const shared = edge.archives.filter(candidate => candidate.layer !== "platform")
    const platform = edge.fromVersion === null
        ? iosFull
        : iosDiff.filter(candidate => matchesDiffEdge(
            candidate.relativePath,
            edge.fromVersion as string,
            edge.toVersion,
        ))
    if (platform.length === 0) {
        // 缺失 iOS edge：不回退 Android platform 归档（维护侧最小边界：不能回传 Android platform archive），
        // 由 prepareIosCompat 将整个 iOS 视图标记为"不可用"。
        return null
    }
    return Object.freeze({ ...edge, archives: Object.freeze([...shared, ...platform]) })
}

// 冻结的 iOS 目录视图缓存：key = cdnRoot，扫描一次，之后不再重扫磁盘（含"不可用"状态）。
const iosCompatCache = new Map<string, IosCompatState>()

/**
 * 构建并冻结 iOS 目录视图（幂等，模块级缓存）。
 * - 实体表（ios_medium.csv）缺失、archive-ios-* 目录整体缺失/为空、
 *   或任一 edge 缺失 iOS 归档 → 明确"不可用"（不回退 Android platform 归档）。
 */
export function prepareIosCompat(snapshot: ContentSnapshot, cdnRoot: string): IosCompatState {
    const cached = iosCompatCache.get(cdnRoot)
    if (cached !== undefined) return cached

    const entityList = resolveIosEntityList(snapshot.cdn, cdnRoot)
    if (entityList === null) {
        const state: IosCompatState = Object.freeze({
            kind: "unavailable",
            reason: "missing ios entity list",
        })
        iosCompatCache.set(cdnRoot, state)
        return state
    }

    const iosFull = readZipArchives(cdnRoot, IOS_FULL_DIRECTORY)
    const iosDiff = readZipArchives(cdnRoot, IOS_DIFF_DIRECTORY)
    if (iosFull.length === 0 && iosDiff.length === 0) {
        const state: IosCompatState = Object.freeze({
            kind: "unavailable",
            reason: "missing ios archive directories",
        })
        iosCompatCache.set(cdnRoot, state)
        return state
    }

    const replaced = snapshot.cdn.edges.map(edge => replacePlatformArchives(edge, iosFull, iosDiff))
    if (replaced.some(edge => edge === null)) {
        const state: IosCompatState = Object.freeze({
            kind: "unavailable",
            reason: "missing ios archive edge",
        })
        iosCompatCache.set(cdnRoot, state)
        return state
    }
    const catalog = Object.freeze({
        ...snapshot.cdn,
        edges: Object.freeze(replaced as ReadonlyArray<CatalogEdge>),
    })
    const installedBytes = readEntityListInstalledBytes(cdnRoot, entityList)
    const state: IosCompatState = Object.freeze({ kind: "ready", catalog, installedBytes })
    iosCompatCache.set(cdnRoot, state)
    return state
}

export function resolveIosEntityList(catalog: CdnCatalog, cdnRoot: string): string | null {
    const androidPath = catalog.entityListsRelativePath
    const expected = androidPath.replace(/android_medium\.csv$/i, "ios_medium.csv")
    if (expected !== androidPath && fs.existsSync(path.join(cdnRoot, ...expected.split("/")))) {
        return expected
    }
    const directory = path.posix.dirname(androidPath)
    const absoluteDirectory = path.join(cdnRoot, ...directory.split("/"))
    let candidates: string[] = []
    try {
        candidates = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
            .filter(entry => entry.isFile() && /-ios_medium\.csv$/i.test(entry.name))
            .map(entry => entry.name)
            .sort((left, right) => left.localeCompare(right))
    } catch {
        // 目录不存在：视为无 iOS 实体表（调用方据此判定不可用，不回落 Android 表）
    }
    if (candidates.length !== 1) return null
    return `${directory}/${candidates[0]}`
}

function readEntityListInstalledBytes(cdnRoot: string, entityList: string): number {
    // 与 Android installedBytes 语义一致：实体表 size 列之和（未压缩字节），
    // 不使用 ZIP 压缩下载量。
    const absolutePath = path.join(cdnRoot, ...entityList.split("/"))
    let total = 0
    try {
        const lines = fs.readFileSync(absolutePath, "utf8").split(/\r?\n/)
        for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed === ENTITY_LIST_HEADER) continue
            const columns = trimmed.split(",")
            if (columns.length < 3) continue
            const size = Number(columns[2])
            if (Number.isSafeInteger(size) && size >= 0) total += size
        }
    } catch {
        // 读取失败按 0 处理（不可用状态由调用方基于实体表缺失判定）
    }
    return total
}

const iosAllowlistCache = new Map<string, ReadonlyMap<string, number>>()

/**
 * archive-ios-* 独立 ZIP allowlist：仅包含冻结 iOS 目录视图中解析出的归档
 * （relativePath → 期望压缩字节数）。不按目录名前缀放行未解析来源。
 */
export function getIosZipAllowlist(snapshot: ContentSnapshot, cdnRoot: string): ReadonlyMap<string, number> {
    const state = prepareIosCompat(snapshot, cdnRoot)
    if (state.kind !== "ready") return EMPTY_ALLOWLIST
    const cached = iosAllowlistCache.get(cdnRoot)
    if (cached !== undefined) return cached
    const allowlist = new Map<string, number>()
    for (const edge of state.catalog.edges) {
        for (const archive of edge.archives) {
            if (isIosArchiveRelativePath(archive.relativePath)) {
                allowlist.set(archive.relativePath, archive.compressedBytes)
            }
        }
    }
    const frozen: ReadonlyMap<string, number> = Object.freeze(allowlist)
    iosAllowlistCache.set(cdnRoot, frozen)
    return frozen
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
