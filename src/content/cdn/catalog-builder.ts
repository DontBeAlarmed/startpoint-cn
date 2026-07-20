import fs from "node:fs"
import path from "node:path"

import type { ContentPaths } from "../paths"
import {
    resolveDigestCache,
    UnstableFileSnapshotError,
    type DigestCacheDependencies,
    type DigestFileCandidate,
} from "./digest-cache"
import { validatePatchGraph } from "./patch-graph"
import type {
    ArchiveLayer,
    AssetSizeKind,
    CatalogArchive,
    CatalogEdge,
    CatalogValidationIssue,
    CatalogValidationIssueCode,
    CdnCatalog,
    CdnCatalogArchiveInput,
    CdnCatalogInput,
    CdnPlatform,
} from "./types"

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const DIFF_ARCHIVE_PATTERN = /^pinball-(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)-(\d+)-([a-fA-F0-9]+)\.zip$/
const FULL_ARCHIVE_PATTERN = /^pinball-(\d+\.\d+\.\d+)-(\d+)-([a-fA-F0-9]+)\.zip$/
const ENTITY_LIST_HEADER = ["path", "version", "size", "hash", "layer"] as const
const ASSET_SIZE_KINDS: ReadonlyArray<AssetSizeKind> = ["shortened", "fulfill"]
const LAYER_ORDER: Readonly<Record<ArchiveLayer, number>> = {
    common: 0,
    quality: 1,
    platform: 2,
}

interface ArchiveDirectory {
    readonly name: string
    readonly kind: "full" | "diff"
    readonly layer: ArchiveLayer
}

const ARCHIVE_DIRECTORIES: ReadonlyArray<ArchiveDirectory> = [
    { name: "archive-common-full", kind: "full", layer: "common" },
    { name: "archive-medium-full", kind: "full", layer: "quality" },
    { name: "archive-android-full", kind: "full", layer: "platform" },
    { name: "archive-common-diff", kind: "diff", layer: "common" },
    { name: "archive-medium-diff", kind: "diff", layer: "quality" },
    { name: "archive-android-diff", kind: "diff", layer: "platform" },
]

export interface ParsedDiffArchiveName {
    readonly fromVersion: string
    readonly toVersion: string
    readonly order: number
}

export interface ParsedFullArchiveName {
    readonly toVersion: string
    readonly order: number
}

interface ScanDirectoryEntry {
    readonly name: string
    isFile?(): boolean
}

export interface ScanCdnCatalogDependencies extends DigestCacheDependencies {
    readonly readdir?: (directory: string) => Promise<ReadonlyArray<string | ScanDirectoryEntry>>
    readonly readEntityList?: (filePath: string) => Promise<Buffer>
}

export class CatalogValidationError extends Error {
    readonly code: CatalogValidationIssueCode
    readonly issues: ReadonlyArray<CatalogValidationIssue>

    constructor(issues: ReadonlyArray<CatalogValidationIssue>) {
        const frozenIssues = Object.freeze(issues.map(item => Object.freeze({ ...item })))
        super(`${frozenIssues[0]?.code ?? "CATALOG_VALIDATION"}: ${frozenIssues[0]?.message ?? "catalog validation failed"}`)
        this.name = "CatalogValidationError"
        this.code = frozenIssues[0]?.code ?? "MISSING_PATH"
        this.issues = frozenIssues
    }
}

function validationIssue(
    code: CatalogValidationIssueCode,
    message: string,
    details: Omit<CatalogValidationIssue, "code" | "message"> = {},
): CatalogValidationIssue {
    return { code, message, ...details }
}

function throwValidationIssue(
    code: CatalogValidationIssueCode,
    message: string,
    details: Omit<CatalogValidationIssue, "code" | "message"> = {},
): never {
    throw new CatalogValidationError([validationIssue(code, message, details)])
}

function parseVersion(version: string): readonly [number, number, number] | null {
    const match = VERSION_PATTERN.exec(version)
    if (!match) return null
    const components = match.slice(1).map(Number)
    if (!components.every(Number.isSafeInteger)) return null
    return components as unknown as readonly [number, number, number]
}

function compareVersions(left: string, right: string): number {
    const leftParts = parseVersion(left)
    const rightParts = parseVersion(right)
    if (!leftParts || !rightParts) return left.localeCompare(right)
    for (let index = 0; index < leftParts.length; index++) {
        const difference = leftParts[index] - rightParts[index]
        if (difference !== 0) return difference
    }
    return 0
}

function parseOrder(value: string): number | null {
    const order = Number(value)
    return Number.isSafeInteger(order) && order > 0 ? order : null
}

export function parseDiffArchiveName(fileName: string): ParsedDiffArchiveName | null {
    const match = DIFF_ARCHIVE_PATTERN.exec(fileName)
    if (!match || !parseVersion(match[1]) || !parseVersion(match[2])) return null
    const order = parseOrder(match[3])
    if (order === null) return null
    return { fromVersion: match[1], toVersion: match[2], order }
}

export function parseFullArchiveName(fileName: string): ParsedFullArchiveName | null {
    const match = FULL_ARCHIVE_PATTERN.exec(fileName)
    if (!match || !parseVersion(match[1])) return null
    const order = parseOrder(match[2])
    if (order === null) return null
    return { toVersion: match[1], order }
}

function parseCsvLine(line: string): string[] {
    const columns: string[] = []
    let value = ""
    let quoted = false
    for (let index = 0; index < line.length; index++) {
        const character = line[index]
        if (character === '"') {
            if (quoted && line[index + 1] === '"') {
                value += '"'
                index++
            } else {
                quoted = !quoted
            }
        } else if (character === "," && !quoted) {
            columns.push(value)
            value = ""
        } else {
            value += character
        }
    }
    if (quoted) throwValidationIssue("INVALID_INSTALLED_BYTES", "EntityLists row has an unterminated quote")
    columns.push(value)
    return columns
}

export function parseEntityListInstalledBytes(content: string | Buffer): number {
    let total = 0
    let contentRows = 0
    const lines = content.toString().replace(/^\uFEFF/, "").split(/\r?\n/)
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex]
        if (!line.trim()) continue
        const columns = parseCsvLine(line)
        const normalizedColumns = columns.map(column => column.trim())
        const isExplicitHeader = contentRows === 0
            && normalizedColumns.length === ENTITY_LIST_HEADER.length
            && normalizedColumns.every((column, index) => column === ENTITY_LIST_HEADER[index])
        contentRows++
        if (isExplicitHeader) continue

        const sizeText = normalizedColumns[2]
        if (normalizedColumns.length !== 5) {
            throwValidationIssue(
                "INVALID_INSTALLED_BYTES",
                `EntityLists row ${lineIndex + 1} must contain exactly five columns`,
            )
        }
        if (!sizeText || !/^\d+$/.test(sizeText)) {
            throwValidationIssue(
                "INVALID_INSTALLED_BYTES",
                `EntityLists row ${lineIndex + 1} has an invalid third column`,
            )
        }
        const size = Number(sizeText)
        if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(total + size)) {
            throwValidationIssue(
                "INVALID_INSTALLED_BYTES",
                `EntityLists row ${lineIndex + 1} exceeds the safe installed byte range`,
            )
        }
        total += size
    }
    return total
}

function isSafeRelativePath(relativePath: string): boolean {
    if (!relativePath || relativePath.includes("\\") || path.posix.isAbsolute(relativePath)) return false
    const normalized = path.posix.normalize(relativePath)
    return normalized === relativePath
        && normalized !== ".."
        && !normalized.startsWith("../")
}

function archiveMetadataKey(archive: CdnCatalogArchiveInput): string {
    return JSON.stringify([
        archive.kind,
        archive.fromVersion,
        archive.toVersion,
        archive.platform,
        archive.layer,
        archive.order,
        archive.compressedBytes,
        archive.sha256,
    ])
}

function inputEdgeKey(archive: CdnCatalogArchiveInput): string {
    return JSON.stringify([
        archive.kind,
        archive.fromVersion,
        archive.toVersion,
        archive.platform,
    ])
}

export function catalogEdgeKey(edge: CatalogEdge): string {
    return JSON.stringify([
        edge.fromVersion === null ? "full" : "diff",
        edge.fromVersion,
        edge.toVersion,
        edge.platform,
        edge.assetSizeKind,
    ])
}

function compareArchives(left: CatalogArchive, right: CatalogArchive): number {
    return LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer]
        || left.order - right.order
        || left.relativePath.localeCompare(right.relativePath)
}

function compareEdges(left: CatalogEdge, right: CatalogEdge): number {
    const modeOrder = ASSET_SIZE_KINDS.indexOf(left.assetSizeKind)
        - ASSET_SIZE_KINDS.indexOf(right.assetSizeKind)
    const kindOrder = Number(left.fromVersion !== null) - Number(right.fromVersion !== null)
    return left.platform.localeCompare(right.platform)
        || modeOrder
        || kindOrder
        || compareVersions(left.fromVersion ?? left.toVersion, right.fromVersion ?? right.toVersion)
        || compareVersions(left.toVersion, right.toVersion)
}

function appendArchiveOrderIssues(
    edges: ReadonlyArray<CatalogEdge>,
    issues: CatalogValidationIssue[],
): void {
    edges.forEach((edge, edgeIndex) => {
        const layers = new Set(edge.archives.map(archive => archive.layer))
        for (const layer of layers) {
            const layerArchives = edge.archives
                .filter(archive => (
                    archive.layer === layer
                    && Number.isSafeInteger(archive.order)
                    && archive.order > 0
                ))
                .sort((left, right) => left.order - right.order)
            const uniqueOrders = [...new Set(layerArchives.map(archive => archive.order))]
            const invalidOrderIndex = uniqueOrders.findIndex((order, index) => order !== index + 1)
            if (invalidOrderIndex === -1) continue

            const invalidOrder = uniqueOrders[invalidOrderIndex]
            const invalidArchive = layerArchives.find(archive => archive.order === invalidOrder) as CatalogArchive
            issues.push(validationIssue(
                "NON_CONTIGUOUS_ARCHIVE_ORDER",
                `${edge.fromVersion === null ? "full" : "diff"} edge ${edge.fromVersion ?? "full"} -> ${edge.toVersion} platform ${edge.platform} mode ${edge.assetSizeKind} layer ${layer} must use contiguous archive orders starting at 1`,
                { edgeIndex, relativePath: invalidArchive.relativePath },
            ))
        }
    })
}

function deepFreeze<T>(value: T): T {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    return Object.freeze(value)
}

function deriveTargetVersion(edges: ReadonlyArray<CatalogEdge>, fullBaseVersion: string): string {
    const outgoing = new Map<string, string>()
    for (const edge of edges) {
        if (edge.platform === "android"
            && edge.assetSizeKind === "shortened"
            && edge.fromVersion !== null) {
            outgoing.set(edge.fromVersion, edge.toVersion)
        }
    }

    let target = fullBaseVersion
    const visited = new Set<string>()
    while (outgoing.has(target) && !visited.has(target)) {
        visited.add(target)
        target = outgoing.get(target) as string
    }
    return target
}

export function buildCdnCatalog(input: CdnCatalogInput): CdnCatalog {
    const issues: CatalogValidationIssue[] = []
    if (!Number.isSafeInteger(input.installedBytes) || input.installedBytes < 0) {
        issues.push(validationIssue(
            "INVALID_INSTALLED_BYTES",
            "installedBytes must be a non-negative safe integer",
        ))
    }
    if (!isSafeRelativePath(input.entityListsRelativePath)) {
        issues.push(validationIssue(
            "INVALID_ARCHIVE_PATH",
            "entityListsRelativePath must be a normalized relative path",
            { relativePath: input.entityListsRelativePath },
        ))
    }

    const archives = [...input.archives].sort((left, right) => (
        left.relativePath.localeCompare(right.relativePath)
        || archiveMetadataKey(left).localeCompare(archiveMetadataKey(right))
    ))
    const paths = new Map<string, CdnCatalogArchiveInput>()
    const edgeGroups = new Map<string, CdnCatalogArchiveInput[]>()
    const orders = new Map<string, number>()

    archives.forEach((archive, archiveIndex) => {
        if (archive.platform !== "android") {
            issues.push(validationIssue(
                "UNSUPPORTED_PLATFORM",
                `unsupported platform ${archive.platform}`,
                { archiveIndex, relativePath: archive.relativePath },
            ))
        }
        if (!parseVersion(archive.toVersion)
            || (archive.kind === "diff" && (typeof archive.fromVersion !== "string" || !parseVersion(archive.fromVersion)))
            || (archive.kind === "full" && archive.fromVersion !== null)
            || !["full", "diff"].includes(archive.kind)) {
            issues.push(validationIssue(
                "INVALID_VERSION",
                `archive ${archive.relativePath} has invalid edge versions`,
                { archiveIndex, relativePath: archive.relativePath },
            ))
        }
        if (archive.kind === "diff"
            && typeof archive.fromVersion === "string"
            && parseVersion(archive.fromVersion)
            && parseVersion(archive.toVersion)
            && compareVersions(archive.fromVersion, archive.toVersion) >= 0) {
            issues.push(validationIssue(
                "INVALID_VERSION",
                `diff edge ${archive.fromVersion} -> ${archive.toVersion} must increase`,
                { archiveIndex, relativePath: archive.relativePath },
            ))
        }
        if (!isSafeRelativePath(archive.relativePath) || !archive.relativePath.endsWith(".zip")) {
            issues.push(validationIssue(
                "INVALID_ARCHIVE_PATH",
                `invalid archive path ${archive.relativePath}`,
                { archiveIndex, relativePath: archive.relativePath },
            ))
        }
        if (!Number.isSafeInteger(archive.compressedBytes) || archive.compressedBytes < 0) {
            issues.push(validationIssue(
                "INVALID_COMPRESSED_BYTES",
                `archive ${archive.relativePath} has invalid compressedBytes`,
                { archiveIndex, relativePath: archive.relativePath },
            ))
        }
        if (!/^[a-f0-9]{64}$/.test(archive.sha256)) {
            issues.push(validationIssue(
                "INVALID_SHA256",
                `archive ${archive.relativePath} has invalid SHA256`,
                { archiveIndex, relativePath: archive.relativePath },
            ))
        }
        if (!Number.isSafeInteger(archive.order) || archive.order <= 0) {
            issues.push(validationIssue(
                "INVALID_ARCHIVE_ORDER",
                `archive ${archive.relativePath} has invalid order`,
                { archiveIndex, relativePath: archive.relativePath },
            ))
        }
        if (!Object.prototype.hasOwnProperty.call(LAYER_ORDER, archive.layer)) {
            issues.push(validationIssue(
                "INVALID_ARCHIVE_PATH",
                `archive ${archive.relativePath} has invalid layer`,
                { archiveIndex, relativePath: archive.relativePath },
            ))
        }

        const previousPath = paths.get(archive.relativePath)
        if (previousPath) {
            issues.push(validationIssue(
                archiveMetadataKey(previousPath) === archiveMetadataKey(archive)
                    ? "DUPLICATE_ARCHIVE_PATH"
                    : "CONFLICTING_ARCHIVE_PATH",
                `archive path ${archive.relativePath} appears more than once`,
                { archiveIndex, relativePath: archive.relativePath },
            ))
        } else {
            paths.set(archive.relativePath, archive)
        }

        const groupKey = inputEdgeKey(archive)
        const group = edgeGroups.get(groupKey) ?? []
        group.push(archive)
        edgeGroups.set(groupKey, group)

        const orderKey = `${groupKey}\u0000${archive.layer}\u0000${archive.order}`
        const previousOrderIndex = orders.get(orderKey)
        if (previousOrderIndex !== undefined) {
            issues.push(validationIssue(
                "DUPLICATE_ARCHIVE_ORDER",
                `archive order duplicates archive ${previousOrderIndex}`,
                { archiveIndex, relativePath: archive.relativePath },
            ))
        } else {
            orders.set(orderKey, archiveIndex)
        }
    })

    for (const group of edgeGroups.values()) {
        const layers = new Set(group.map(archive => archive.layer))
        for (const requiredLayer of ["common", "quality", "platform"] as const) {
            if (!layers.has(requiredLayer)) {
                const representative = group[0]
                issues.push(validationIssue(
                    "MISSING_ARCHIVE_LAYER",
                    `${representative.kind} edge ${representative.fromVersion ?? "full"} -> ${representative.toVersion} is missing ${requiredLayer}`,
                    { relativePath: representative.relativePath },
                ))
            }
        }
    }

    const fullBaseVersions = [...new Set(archives
        .filter(archive => archive.kind === "full")
        .map(archive => archive.toVersion))]
        .sort(compareVersions)
    if (fullBaseVersions.length === 0) {
        issues.push(validationIssue("MISSING_PATH", "catalog has no full base archive"))
    } else if (fullBaseVersions.length > 1) {
        issues.push(validationIssue(
            "CONFLICTING_EDGE",
            `catalog has multiple full base versions: ${fullBaseVersions.join(", ")}`,
        ))
    }
    const fullBaseVersion = fullBaseVersions[0] ?? "0.0.0"

    const edges: CatalogEdge[] = []
    for (const group of edgeGroups.values()) {
        const representative = group[0]
        const catalogArchives: CatalogArchive[] = group.map(archive => ({
            relativePath: archive.relativePath,
            compressedBytes: archive.compressedBytes,
            sha256: archive.sha256,
            layer: archive.layer,
            order: archive.order,
        })).sort(compareArchives)

        for (const assetSizeKind of ASSET_SIZE_KINDS) {
            if (representative.kind === "full") {
                edges.push({
                    fromVersion: null,
                    toVersion: representative.toVersion,
                    platform: representative.platform,
                    assetSizeKind,
                    archives: catalogArchives,
                })
            } else {
                edges.push({
                    fromVersion: representative.fromVersion as string,
                    toVersion: representative.toVersion,
                    platform: representative.platform,
                    assetSizeKind,
                    archives: catalogArchives,
                })
            }
        }
    }
    edges.sort(compareEdges)
    appendArchiveOrderIssues(edges, issues)
    issues.push(...validatePatchGraph(edges, fullBaseVersion))

    if (issues.length > 0) throw new CatalogValidationError(issues)
    const catalog: CdnCatalog = {
        schemaVersion: 1,
        fullBaseVersion,
        targetVersion: deriveTargetVersion(edges, fullBaseVersion),
        installedBytes: input.installedBytes,
        entityListsRelativePath: input.entityListsRelativePath,
        edges,
    }
    return deepFreeze(catalog)
}

async function readDirectory(
    directory: string,
    readdir: NonNullable<ScanCdnCatalogDependencies["readdir"]>,
): Promise<ReadonlyArray<string | ScanDirectoryEntry>> {
    try {
        return await readdir(directory)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
        throw error
    }
}

function fileNames(entries: ReadonlyArray<string | ScanDirectoryEntry>): string[] {
    return entries
        .filter(entry => typeof entry === "string" || entry.isFile?.() !== false)
        .map(entry => typeof entry === "string" ? entry : entry.name)
        .sort((left, right) => left.localeCompare(right))
}

export async function scanCdnCatalogInput(
    paths: ContentPaths,
    dependencies: ScanCdnCatalogDependencies = {},
): Promise<CdnCatalogInput> {
    const readdir = dependencies.readdir ?? (directory => fs.promises.readdir(directory, { withFileTypes: true }))
    const readEntityList = dependencies.readEntityList ?? (filePath => fs.promises.readFile(filePath))
    const entityListsDirectory = path.join(paths.cdnRoot, "EntityLists")
    const entityCandidates = fileNames(await readDirectory(entityListsDirectory, readdir))
        .filter(fileName => /-android_medium\.csv$/.test(fileName))
    if (entityCandidates.length === 0) {
        throwValidationIssue("MISSING_PATH", "missing Android medium EntityLists CSV")
    }
    if (entityCandidates.length > 1) {
        throwValidationIssue(
            "AMBIGUOUS_PATH",
            `multiple Android medium EntityLists CSV files: ${entityCandidates.join(", ")}`,
        )
    }
    const entityListsRelativePath = `EntityLists/${entityCandidates[0]}`
    const entityListContent = await readEntityList(path.join(paths.cdnRoot, entityListsRelativePath))
    const installedBytes = parseEntityListInstalledBytes(entityListContent)
    const pendingArchives: Array<{
        readonly archive: Omit<CdnCatalogArchiveInput, "compressedBytes" | "sha256">
        readonly digest: DigestFileCandidate
    }> = []

    for (const directory of ARCHIVE_DIRECTORIES) {
        const absoluteDirectory = path.join(paths.cdnRoot, directory.name)
        for (const fileName of fileNames(await readDirectory(absoluteDirectory, readdir))) {
            if (!fileName.endsWith(".zip")) continue
            const parsed = directory.kind === "full"
                ? parseFullArchiveName(fileName)
                : parseDiffArchiveName(fileName)
            if (!parsed) {
                throwValidationIssue(
                    "INVALID_ARCHIVE_PATH",
                    `invalid archive name ${directory.name}/${fileName}`,
                    { relativePath: `${directory.name}/${fileName}` },
                )
            }
            const relativePath = `${directory.name}/${fileName}`
            const absolutePath = path.join(absoluteDirectory, fileName)
            const edge = directory.kind === "full"
                ? { kind: "full" as const, fromVersion: null, toVersion: parsed.toVersion }
                : {
                    kind: "diff" as const,
                    fromVersion: (parsed as ParsedDiffArchiveName).fromVersion,
                    toVersion: parsed.toVersion,
                }
            pendingArchives.push({
                archive: {
                    ...edge,
                    platform: "android" as CdnPlatform,
                    layer: directory.layer,
                    order: parsed.order,
                    relativePath,
                },
                digest: {
                    path: relativePath,
                    absolutePath,
                },
            })
        }
    }

    const digestCachePath = path.join(paths.contentStateDir, "cdn-digest-cache.json")
    let snapshots
    try {
        snapshots = await resolveDigestCache(
            pendingArchives.map(item => item.digest),
            digestCachePath,
            dependencies,
        )
    } catch (error) {
        if (error instanceof UnstableFileSnapshotError) {
            throwValidationIssue(
                "UNSTABLE_ARCHIVE_SNAPSHOT",
                error.message,
                { relativePath: error.relativePath },
            )
        }
        throw error
    }
    const archives: CdnCatalogArchiveInput[] = pendingArchives.map(item => {
        const snapshot = snapshots.get(item.archive.relativePath)
        if (!snapshot) throw new Error(`missing archive snapshot: ${item.archive.relativePath}`)
        return {
            ...item.archive,
            compressedBytes: snapshot.size,
            sha256: snapshot.digest,
        }
    })

    return {
        archives,
        installedBytes,
        entityListsRelativePath,
    }
}
