import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import {
    buildCdnCatalog,
    CatalogValidationError,
    parseDiffArchiveName,
    parseEntityListInstalledBytes,
    parseFullArchiveName,
    type ParsedDiffArchiveName,
} from "../cdn/catalog-builder"
import type { DigestFileHandle } from "../cdn/digest-cache"
import { parseCdnRuntimeManifest } from "../cdn/runtime-manifest"
import type { ArchiveLayer, CdnCatalogArchiveInput, CdnCatalogInput, CdnPlatform } from "../cdn/types"
import { deepFreeze } from "../deep-freeze"
import type { ContentPaths } from "../paths"

const PLACEHOLDER_DIGEST = "0".repeat(64)
const TRACKED_BASELINE_PATH = path.resolve(
    __dirname,
    "../../../assets/cdn/catalog-cn-1.4.54.json",
)

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

interface ScanDirectoryEntry {
    readonly name: string
    isFile?(): boolean
    isDirectory?(): boolean
    isSymbolicLink?(): boolean
}

interface FileSnapshotStat {
    readonly size: bigint
    readonly mtimeMs: bigint
    readonly ctimeMs: bigint
    readonly dev: bigint
    readonly ino: bigint
    isFile(): boolean
}

export interface ContentFileFingerprint {
    readonly physicalPath: string
    readonly compressedBytes: number
    readonly mtimeMs: string
    readonly ctimeMs: string
    readonly dev: string
    readonly ino: string
}

export interface ContentArchiveDescriptor extends ContentFileFingerprint {
    readonly kind: "full" | "diff"
    readonly fromVersion: string | null
    readonly toVersion: string
    readonly platform: CdnPlatform
    readonly layer: ArchiveLayer
    readonly order: number
    readonly relativePath: string
}

export interface ContentTargetScan {
    readonly cdnRoot: string
    readonly targetVersion: string
    readonly entityListsRelativePath: string
    readonly entityListsFingerprint: ContentFileFingerprint
    readonly archives: readonly ContentArchiveDescriptor[]
    readonly ignoredPaths: readonly string[]
}

export interface ContentScannerDependencies {
    readonly readdir?: (directory: string) => Promise<ReadonlyArray<string | ScanDirectoryEntry>>
    readonly stat?: (filePath: string) => Promise<FileSnapshotStat>
    readonly realpath?: (filePath: string) => Promise<string>
    readonly readEntityList?: (
        fileHandle: DigestFileHandle,
        filePath: string,
    ) => Promise<Buffer>
    readonly openFile?: (filePath: string) => Promise<DigestFileHandle>
}

export interface MaterializeContentCatalogOptions extends ContentScannerDependencies {
    readonly baselineInput?: CdnCatalogInput
    readonly digestArchive?: (fileHandle: DigestFileHandle, filePath: string) => Promise<string>
}

interface SecureSnapshot {
    readonly physicalPath: string
    readonly fingerprint: ContentFileFingerprint
}

function validationError(
    code: "AMBIGUOUS_PATH" | "INVALID_ARCHIVE_PATH" | "INVALID_SHA256" | "MISSING_PATH" | "UNSTABLE_ARCHIVE_SNAPSHOT",
    message: string,
    relativePath?: string,
): CatalogValidationError {
    return new CatalogValidationError([{
        code,
        message,
        ...(relativePath === undefined ? {} : { relativePath }),
    }])
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
    const relativePath = path.relative(parent, candidate)
    return relativePath === ""
        || (!path.isAbsolute(relativePath)
            && relativePath !== ".."
            && !relativePath.startsWith(`..${path.sep}`))
}

function fingerprint(
    relativePath: string,
    physicalPath: string,
    stat: FileSnapshotStat,
): ContentFileFingerprint {
    if (!stat.isFile()) throw new Error(`content path is not a regular file: ${relativePath}`)
    if (stat.size < BigInt(0) || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`content path has unsupported file metadata: ${relativePath}`)
    }
    return {
        physicalPath,
        compressedBytes: Number(stat.size),
        mtimeMs: stat.mtimeMs.toString(10),
        ctimeMs: stat.ctimeMs.toString(10),
        dev: stat.dev.toString(10),
        ino: stat.ino.toString(10),
    }
}

function sameFingerprint(left: ContentFileFingerprint, right: ContentFileFingerprint): boolean {
    return left.physicalPath === right.physicalPath
        && left.compressedBytes === right.compressedBytes
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs
        && left.dev === right.dev
        && left.ino === right.ino
}

function defaultStat(filePath: string): Promise<FileSnapshotStat> {
    return fs.promises.stat(filePath, { bigint: true })
}

async function secureSnapshot(
    cdnRoot: string,
    cdnRealRoot: string,
    relativePath: string,
    dependencies: ContentScannerDependencies,
): Promise<SecureSnapshot> {
    const absolutePath = path.resolve(cdnRoot, relativePath)
    if (!isSameOrDescendant(path.resolve(cdnRoot), absolutePath)) {
        throw validationError("INVALID_ARCHIVE_PATH", `${relativePath} escapes cdnRoot`, relativePath)
    }

    const realpath = dependencies.realpath ?? (filePath => fs.promises.realpath(filePath))
    const physicalPath = path.resolve(await realpath(absolutePath))
    if (!isSameOrDescendant(cdnRealRoot, physicalPath)) {
        throw validationError("INVALID_ARCHIVE_PATH", `${relativePath} resolves outside cdnRoot`, relativePath)
    }

    const stat = dependencies.stat ?? defaultStat
    const before = fingerprint(relativePath, physicalPath, await stat(physicalPath))
    const after = fingerprint(relativePath, physicalPath, await stat(physicalPath))
    if (!sameFingerprint(before, after)) {
        throw validationError(
            "UNSTABLE_ARCHIVE_SNAPSHOT",
            `content file changed while scanning: ${relativePath}`,
            relativePath,
        )
    }
    return { physicalPath, fingerprint: after }
}

async function assertDirectoryInsideRoot(
    cdnRoot: string,
    cdnRealRoot: string,
    relativePath: string,
    dependencies: ContentScannerDependencies,
): Promise<void> {
    const realpath = dependencies.realpath ?? (filePath => fs.promises.realpath(filePath))
    let physicalPath: string
    try {
        physicalPath = path.resolve(await realpath(path.join(cdnRoot, relativePath)))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
    }
    if (!isSameOrDescendant(cdnRealRoot, physicalPath)) {
        throw validationError(
            "INVALID_ARCHIVE_PATH",
            `${relativePath} directory resolves outside cdnRoot`,
            relativePath,
        )
    }
}

async function readDirectory(
    directory: string,
    readdir: NonNullable<ContentScannerDependencies["readdir"]>,
): Promise<ReadonlyArray<string | ScanDirectoryEntry>> {
    try {
        return await readdir(directory)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
        throw error
    }
}

async function regularFileNames(
    directory: string,
    dependencies: ContentScannerDependencies,
): Promise<string[]> {
    const readdir = dependencies.readdir
        ?? (filePath => fs.promises.readdir(filePath, { withFileTypes: true }))
    const entries = await readDirectory(directory, readdir)
    const names: string[] = []
    for (const entry of entries) {
        if (typeof entry !== "string"
            && entry.isFile?.() === false
            && entry.isSymbolicLink?.() !== true) continue
        const name = typeof entry === "string" ? entry : entry.name
        if (typeof entry === "string") {
            try {
                const stat = dependencies.stat ?? defaultStat
                if (!(await stat(path.join(directory, name))).isFile()) continue
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
                throw error
            }
        }
        names.push(name)
    }
    return names.sort((left, right) => left.localeCompare(right))
}

function descriptorInput(archive: ContentArchiveDescriptor, sha256: string): CdnCatalogArchiveInput {
    return {
        kind: archive.kind,
        fromVersion: archive.fromVersion,
        toVersion: archive.toVersion,
        platform: archive.platform,
        layer: archive.layer,
        order: archive.order,
        relativePath: archive.relativePath,
        compressedBytes: archive.compressedBytes,
        sha256,
    }
}

export async function scanContentTarget(
    paths: ContentPaths,
    dependencies: ContentScannerDependencies = {},
): Promise<ContentTargetScan> {
    const cdnRoot = path.resolve(paths.cdnRoot)
    const realpath = dependencies.realpath ?? (filePath => fs.promises.realpath(filePath))
    const cdnRealRoot = path.resolve(await realpath(cdnRoot))
    const ignoredPaths: string[] = []

    for (const fileName of await regularFileNames(cdnRoot, dependencies)) {
        ignoredPaths.push(fileName)
    }

    const entityDirectory = path.join(cdnRoot, "EntityLists")
    await assertDirectoryInsideRoot(cdnRoot, cdnRealRoot, "EntityLists", dependencies)
    const entityFileNames = await regularFileNames(entityDirectory, dependencies)
    const entityCandidates = entityFileNames.filter(fileName => /-android_medium\.csv$/.test(fileName))
    for (const fileName of entityFileNames) {
        if (!entityCandidates.includes(fileName)) ignoredPaths.push(`EntityLists/${fileName}`)
    }
    if (entityCandidates.length === 0) {
        throw validationError("MISSING_PATH", "missing Android medium EntityLists CSV")
    }
    if (entityCandidates.length > 1) {
        throw validationError(
            "AMBIGUOUS_PATH",
            `multiple Android medium EntityLists CSV files: ${entityCandidates.join(", ")}`,
        )
    }
    const entityListsRelativePath = `EntityLists/${entityCandidates[0]}`
    const entitySnapshot = await secureSnapshot(
        cdnRoot,
        cdnRealRoot,
        entityListsRelativePath,
        dependencies,
    )

    const archives: ContentArchiveDescriptor[] = []
    for (const directory of ARCHIVE_DIRECTORIES) {
        const absoluteDirectory = path.join(cdnRoot, directory.name)
        await assertDirectoryInsideRoot(cdnRoot, cdnRealRoot, directory.name, dependencies)
        for (const fileName of await regularFileNames(absoluteDirectory, dependencies)) {
            const relativePath = `${directory.name}/${fileName}`
            if (!/\.zip$/i.test(fileName)) {
                ignoredPaths.push(relativePath)
                continue
            }
            const parsed = directory.kind === "full"
                ? parseFullArchiveName(fileName)
                : parseDiffArchiveName(fileName)
            if (!parsed) {
                throw validationError(
                    "INVALID_ARCHIVE_PATH",
                    `invalid archive name ${relativePath}`,
                    relativePath,
                )
            }
            const snapshot = await secureSnapshot(cdnRoot, cdnRealRoot, relativePath, dependencies)
            archives.push({
                kind: directory.kind,
                fromVersion: directory.kind === "full"
                    ? null
                    : (parsed as ParsedDiffArchiveName).fromVersion,
                toVersion: parsed.toVersion,
                platform: "android",
                layer: directory.layer,
                order: parsed.order,
                relativePath,
                ...snapshot.fingerprint,
            })
        }
    }
    archives.sort((left, right) => left.relativePath.localeCompare(right.relativePath))

    const structuralInput: CdnCatalogInput = {
        archives: archives.map(archive => descriptorInput(archive, PLACEHOLDER_DIGEST)),
        installedBytes: 0,
        entityListsRelativePath,
    }
    const catalog = buildCdnCatalog(structuralInput)
    return deepFreeze({
        cdnRoot,
        targetVersion: catalog.targetVersion,
        entityListsRelativePath,
        entityListsFingerprint: entitySnapshot.fingerprint,
        archives,
        ignoredPaths: [...new Set(ignoredPaths)].sort((left, right) => left.localeCompare(right)),
    })
}

async function defaultDigestArchive(fileHandle: DigestFileHandle): Promise<string> {
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(64 * 1024)
    let position = 0
    while (true) {
        const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        hash.update(buffer.subarray(0, bytesRead))
        position += bytesRead
    }
    return hash.digest("hex")
}

async function defaultReadEntityList(fileHandle: DigestFileHandle): Promise<Buffer> {
    const chunks: Buffer[] = []
    const buffer = Buffer.alloc(64 * 1024)
    let position = 0
    while (true) {
        const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
        position += bytesRead
    }
    return Buffer.concat(chunks)
}

async function loadTrackedBaselineInput(): Promise<CdnCatalogInput> {
    let value: unknown
    try {
        value = JSON.parse(await fs.promises.readFile(TRACKED_BASELINE_PATH, "utf8"))
    } catch (error) {
        throw new Error(
            `cannot read tracked CDN catalog baseline: ${(error as Error).message}`,
        )
    }
    try {
        return parseCdnRuntimeManifest(value).catalogInput
    } catch (error) {
        throw new Error(
            `tracked CDN catalog baseline is invalid: ${(error as Error).message}`,
        )
    }
}

function assertUnchanged(
    expected: ContentFileFingerprint,
    actual: ContentFileFingerprint,
    relativePath: string,
): void {
    if (!sameFingerprint(expected, actual)) {
        throw validationError(
            "UNSTABLE_ARCHIVE_SNAPSHOT",
            `content file changed after target scan: ${relativePath}`,
            relativePath,
        )
    }
}

export async function materializeContentCatalogInput(
    scan: ContentTargetScan,
    options: MaterializeContentCatalogOptions = {},
): Promise<CdnCatalogInput> {
    const cdnRoot = path.resolve(scan.cdnRoot)
    const realpath = options.realpath ?? (filePath => fs.promises.realpath(filePath))
    const cdnRealRoot = path.resolve(await realpath(cdnRoot))
    const baseline = options.baselineInput ?? await loadTrackedBaselineInput()
    buildCdnCatalog(baseline)
    const baselineByPath = new Map(baseline.archives.map(archive => [archive.relativePath, archive]))

    const openFile = options.openFile ?? (filePath => fs.promises.open(
        filePath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    ))
    const entityBefore = await secureSnapshot(
        cdnRoot,
        cdnRealRoot,
        scan.entityListsRelativePath,
        options,
    )
    assertUnchanged(scan.entityListsFingerprint, entityBefore.fingerprint, scan.entityListsRelativePath)
    const readEntityList = options.readEntityList ?? defaultReadEntityList
    const entityHandle = await openFile(entityBefore.physicalPath)
    let entityContent: Buffer
    try {
        const handleBefore = fingerprint(
            scan.entityListsRelativePath,
            entityBefore.physicalPath,
            await entityHandle.stat({ bigint: true }),
        )
        assertUnchanged(scan.entityListsFingerprint, handleBefore, scan.entityListsRelativePath)
        entityContent = await readEntityList(entityHandle, entityBefore.physicalPath)
        const handleAfter = fingerprint(
            scan.entityListsRelativePath,
            entityBefore.physicalPath,
            await entityHandle.stat({ bigint: true }),
        )
        assertUnchanged(scan.entityListsFingerprint, handleAfter, scan.entityListsRelativePath)
    } finally {
        await entityHandle.close()
    }
    const entityAfter = await secureSnapshot(
        cdnRoot,
        cdnRealRoot,
        scan.entityListsRelativePath,
        options,
    )
    assertUnchanged(scan.entityListsFingerprint, entityAfter.fingerprint, scan.entityListsRelativePath)
    const installedBytes = parseEntityListInstalledBytes(entityContent)

    const digestArchive = options.digestArchive ?? defaultDigestArchive
    const archives: CdnCatalogArchiveInput[] = []
    for (const descriptor of scan.archives) {
        const before = await secureSnapshot(cdnRoot, cdnRealRoot, descriptor.relativePath, options)
        assertUnchanged(descriptor, before.fingerprint, descriptor.relativePath)
        const tracked = baselineByPath.get(descriptor.relativePath)
        let sha256: string
        if (tracked && tracked.compressedBytes === descriptor.compressedBytes) {
            sha256 = tracked.sha256
        } else {
            const fileHandle = await openFile(before.physicalPath)
            try {
                const handleBefore = fingerprint(
                    descriptor.relativePath,
                    before.physicalPath,
                    await fileHandle.stat({ bigint: true }),
                )
                assertUnchanged(descriptor, handleBefore, descriptor.relativePath)
                sha256 = await digestArchive(fileHandle, before.physicalPath)
                const handleAfter = fingerprint(
                    descriptor.relativePath,
                    before.physicalPath,
                    await fileHandle.stat({ bigint: true }),
                )
                assertUnchanged(descriptor, handleAfter, descriptor.relativePath)
            } finally {
                await fileHandle.close()
            }
        }
        if (!/^[a-f0-9]{64}$/.test(sha256)) {
            throw validationError(
                "INVALID_SHA256",
                `archive digest is not a lowercase SHA256: ${descriptor.relativePath}`,
                descriptor.relativePath,
            )
        }
        const after = await secureSnapshot(cdnRoot, cdnRealRoot, descriptor.relativePath, options)
        assertUnchanged(descriptor, after.fingerprint, descriptor.relativePath)
        archives.push(descriptorInput(descriptor, sha256))
    }

    const input: CdnCatalogInput = {
        archives,
        installedBytes,
        entityListsRelativePath: scan.entityListsRelativePath,
    }
    const catalog = buildCdnCatalog(input)
    if (catalog.targetVersion !== scan.targetVersion) {
        throw validationError("UNSTABLE_ARCHIVE_SNAPSHOT", "catalog target changed after target scan")
    }
    return deepFreeze(input)
}
