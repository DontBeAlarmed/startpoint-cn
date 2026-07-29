import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { ContentPaths } from "../paths"
import { deepFreeze } from "../deep-freeze"
import { parseDiffArchiveName } from "./catalog-builder"
import type { ArchiveLayer, CdnCatalog } from "./types"
import { parsePatchManifest, type PatchManifest } from "./patch-manifest"

export type PatchOverlayErrorCode =
    | "PATCH_DIRECTORY_VERSION_MISMATCH"
    | "PATCH_BASE_VERSION_MISSING"
    | "PATCH_BASE_VERSION_CYCLE"
    | "PATCH_ARCHIVE_FILE_MISSING"
    | "PATCH_ARCHIVE_FILE_TYPE"
    | "PATCH_ARCHIVE_SIZE_MISMATCH"
    | "PATCH_ARCHIVE_HASH_MISMATCH"
    | "PATCH_ARCHIVE_SYMLINK"
    | "PATCH_ARCHIVE_TARGET_MISMATCH"

export class PatchOverlayError extends Error {
    readonly code: PatchOverlayErrorCode
    readonly patchVersion: string
    readonly relativePath: string | null

    constructor(
        code: PatchOverlayErrorCode,
        patchVersion: string,
        message: string,
        relativePath: string | null = null,
    ) {
        super(`${code}: patch ${patchVersion}: ${message}`)
        this.name = "PatchOverlayError"
        this.code = code
        this.patchVersion = patchVersion
        this.relativePath = relativePath
    }
}

export interface PatchArchiveScan {
    readonly source: { readonly kind: "patch"; readonly targetVersion: string }
    readonly kind: "diff"
    readonly fromVersion: string
    readonly toVersion: string
    readonly platform: "android"
    readonly layer: ArchiveLayer
    readonly order: number
    readonly relativePath: string
    readonly compressedBytes: number
    readonly expectedSha256: string
    readonly physicalPath: string
    readonly mtimeMs: string
    readonly ctimeMs: string
    readonly dev: string
    readonly ino: string
}

export interface PatchDirectoryFingerprint {
    readonly physicalPath: string
    readonly mtimeMs: string
    readonly ctimeMs: string
    readonly dev: string
    readonly ino: string
}

export interface PatchManifestFingerprint {
    readonly targetVersion: string
    readonly relativePath: "patch-manifest.json"
    readonly physicalPath: string
    readonly compressedBytes: number
    readonly mtimeMs: string
    readonly ctimeMs: string
    readonly dev: string
    readonly ino: string
    readonly sha256: string
    readonly patchesRoot: PatchDirectoryFingerprint
    readonly packageRoot: PatchDirectoryFingerprint
}

export interface PatchOverlayScan {
    readonly archives: readonly PatchArchiveScan[]
    readonly manifests: readonly PatchManifestFingerprint[]
    readonly ignoredPaths: readonly string[]
}

interface DirectoryEntry {
    readonly name: string
    isDirectory(): boolean
    isFile(): boolean
    isSymbolicLink(): boolean
}

interface FileStat {
    readonly size: bigint
    readonly mtimeMs: bigint
    readonly ctimeMs: bigint
    readonly dev: bigint
    readonly ino: bigint
    isDirectory(): boolean
    isFile(): boolean
    isSymbolicLink(): boolean
}

export interface PatchOverlayDependencies {
    readonly readdir?: (directory: string) => Promise<readonly DirectoryEntry[]>
    readonly lstat?: (filePath: string) => Promise<FileStat>
    readonly realpath?: (filePath: string) => Promise<string>
    readonly readFile?: (filePath: string) => Promise<Buffer>
}

interface DiscoveredPackage {
    readonly directoryName: string
    readonly packageRoot: string
    readonly physicalRoot: string
    readonly patchesRootFingerprint: PatchDirectoryFingerprint
    readonly packageRootFingerprint: PatchDirectoryFingerprint
    readonly manifestFingerprint: PatchManifestFingerprint
    readonly manifest: PatchManifest
    readonly ignoredPaths: readonly string[]
}

const LAYER_DIRECTORIES: Readonly<Record<PatchManifest["archives"][number]["layer"], {
    readonly directory: string
    readonly catalogLayer: ArchiveLayer
}>> = {
    common: { directory: "archive-common-diff", catalogLayer: "common" },
    medium: { directory: "archive-medium-diff", catalogLayer: "quality" },
    android: { directory: "archive-android-diff", catalogLayer: "platform" },
}

function isMissing(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR"
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
    const relativePath = path.relative(parent, candidate)
    return relativePath === ""
        || (!path.isAbsolute(relativePath)
            && relativePath !== ".."
            && !relativePath.startsWith(`..${path.sep}`))
}

function sameStatIdentity(left: FileStat, right: FileStat): boolean {
    return left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs
        && left.dev === right.dev
        && left.ino === right.ino
}

function directoryFingerprint(
    physicalPath: string,
    stat: FileStat,
): PatchDirectoryFingerprint {
    return {
        physicalPath,
        mtimeMs: stat.mtimeMs.toString(10),
        ctimeMs: stat.ctimeMs.toString(10),
        dev: stat.dev.toString(10),
        ino: stat.ino.toString(10),
    }
}

function sameDirectoryFingerprint(
    left: PatchDirectoryFingerprint,
    right: PatchDirectoryFingerprint,
): boolean {
    return left.physicalPath === right.physicalPath
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs
        && left.dev === right.dev
        && left.ino === right.ino
}

function defaultLstat(filePath: string): Promise<FileStat> {
    return fs.promises.lstat(filePath, { bigint: true })
}

async function requiredRealpath(
    filePath: string,
    version: string,
    label: string,
    relativePath: string | null,
    dependencies: PatchOverlayDependencies,
): Promise<string> {
    const realpath = dependencies.realpath ?? (value => fs.promises.realpath(value))
    try {
        return path.resolve(await realpath(filePath))
    } catch (error) {
        if (isMissing(error)) {
            fail("PATCH_ARCHIVE_FILE_MISSING", version, `${label} disappeared while scanning`, relativePath)
        }
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
            fail("PATCH_ARCHIVE_SYMLINK", version, `${label} contains a symbolic-link loop`, relativePath)
        }
        throw error
    }
}

async function requiredReadFile(
    filePath: string,
    version: string,
    relativePath: string,
    dependencies: PatchOverlayDependencies,
): Promise<Buffer> {
    const readFile = dependencies.readFile ?? (value => fs.promises.readFile(value))
    try {
        return await readFile(filePath)
    } catch (error) {
        if (isMissing(error)) {
            fail("PATCH_ARCHIVE_FILE_MISSING", version, "patch manifest disappeared while reading", relativePath)
        }
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
            fail("PATCH_ARCHIVE_SYMLINK", version, "patch manifest became a symbolic-link loop", relativePath)
        }
        throw error
    }
}

async function snapshotDirectory(
    directoryPath: string,
    version: string,
    label: string,
    dependencies: PatchOverlayDependencies,
): Promise<PatchDirectoryFingerprint> {
    const lstat = dependencies.lstat ?? defaultLstat
    let before: FileStat
    try {
        before = await lstat(directoryPath)
    } catch (error) {
        if (isMissing(error)) {
            fail("PATCH_ARCHIVE_FILE_MISSING", version, `${label} is missing`)
        }
        throw error
    }
    if (before.isSymbolicLink()) {
        fail("PATCH_ARCHIVE_SYMLINK", version, `${label} is a symbolic link`)
    }
    if (!before.isDirectory()) {
        fail("PATCH_ARCHIVE_FILE_TYPE", version, `${label} is not a directory`)
    }
    const physicalPath = await requiredRealpath(
        directoryPath,
        version,
        label,
        null,
        dependencies,
    )
    let after: FileStat
    try {
        after = await lstat(directoryPath)
    } catch (error) {
        if (isMissing(error)) {
            fail("PATCH_ARCHIVE_FILE_MISSING", version, `${label} disappeared while scanning`)
        }
        throw error
    }
    if (after.isSymbolicLink()) {
        fail("PATCH_ARCHIVE_SYMLINK", version, `${label} became a symbolic link`)
    }
    if (!after.isDirectory() || !sameStatIdentity(before, after)) {
        fail("PATCH_ARCHIVE_SYMLINK", version, `${label} changed while scanning`)
    }
    const physicalAfter = await requiredRealpath(
        directoryPath,
        version,
        label,
        null,
        dependencies,
    )
    if (physicalAfter !== physicalPath) {
        fail("PATCH_ARCHIVE_SYMLINK", version, `${label} resolved path changed while scanning`)
    }
    return directoryFingerprint(physicalPath, after)
}

async function assertDirectoryUnchanged(
    directoryPath: string,
    expected: PatchDirectoryFingerprint,
    version: string,
    label: string,
    dependencies: PatchOverlayDependencies,
): Promise<void> {
    const actual = await snapshotDirectory(directoryPath, version, label, dependencies)
    if (!sameDirectoryFingerprint(expected, actual)) {
        fail("PATCH_ARCHIVE_SYMLINK", version, `${label} identity changed while scanning`)
    }
}

function fail(
    code: PatchOverlayErrorCode,
    version: string,
    message: string,
    relativePath: string | null = null,
): never {
    throw new PatchOverlayError(code, version, message, relativePath)
}

async function directoryEntries(
    directory: string,
    dependencies: PatchOverlayDependencies,
): Promise<readonly DirectoryEntry[]> {
    const readdir = dependencies.readdir
        ?? (value => fs.promises.readdir(value, { withFileTypes: true }))
    try {
        return await readdir(directory)
    } catch (error) {
        if (isMissing(error)) return []
        throw error
    }
}

function compareVersions(left: string, right: string): number {
    const leftParts = left.split(".").map(Number)
    const rightParts = right.split(".").map(Number)
    for (let index = 0; index < 3; index++) {
        const difference = leftParts[index] - rightParts[index]
        if (difference !== 0) return difference
    }
    return 0
}

async function snapshotRelativeComponents(
    root: string,
    relativePath: string,
    version: string,
    dependencies: PatchOverlayDependencies,
): Promise<readonly FileStat[]> {
    const lstat = dependencies.lstat ?? defaultLstat
    const segments = relativePath.split("/")
    const snapshots: FileStat[] = []
    let candidate = root
    for (const [index, segment] of segments.entries()) {
        candidate = path.join(candidate, segment)
        let stat: FileStat
        try {
            stat = await lstat(candidate)
        } catch (error) {
            if (isMissing(error)) {
                fail("PATCH_ARCHIVE_FILE_MISSING", version, "declared path is missing", relativePath)
            }
            throw error
        }
        if (stat.isSymbolicLink()) {
            fail("PATCH_ARCHIVE_SYMLINK", version, "declared path contains a symbolic link", relativePath)
        }
        const isLast = index === segments.length - 1
        if ((!isLast && !stat.isDirectory()) || (isLast && !stat.isFile())) {
            fail("PATCH_ARCHIVE_FILE_TYPE", version, "declared path has the wrong file type", relativePath)
        }
        snapshots.push(stat)
    }
    return snapshots
}

function assertSameComponents(
    before: readonly FileStat[],
    after: readonly FileStat[],
    version: string,
    relativePath: string,
): void {
    if (before.length !== after.length
        || before.some((stat, index) => !sameStatIdentity(stat, after[index]))) {
        fail("PATCH_ARCHIVE_SYMLINK", version, "declared path identity changed while scanning", relativePath)
    }
}

async function readPackage(
    patchesRoot: string,
    patchesRootFingerprint: PatchDirectoryFingerprint,
    entry: DirectoryEntry,
    dependencies: PatchOverlayDependencies,
): Promise<DiscoveredPackage | null> {
    const directoryName = entry.name
    if (entry.isSymbolicLink()) {
        fail("PATCH_ARCHIVE_SYMLINK", directoryName, "patch version directory is a symbolic link")
    }
    if (!entry.isDirectory()) return null

    const packageRoot = path.join(patchesRoot, directoryName)
    await assertDirectoryUnchanged(
        patchesRoot,
        patchesRootFingerprint,
        directoryName,
        "patches root",
        dependencies,
    )
    const packageRootFingerprint = await snapshotDirectory(
        packageRoot,
        directoryName,
        "patch version directory",
        dependencies,
    )
    const physicalRoot = packageRootFingerprint.physicalPath
    if (!isSameOrDescendant(patchesRootFingerprint.physicalPath, physicalRoot)
        || physicalRoot === patchesRootFingerprint.physicalPath) {
        fail("PATCH_ARCHIVE_SYMLINK", directoryName, "patch version directory resolves outside patches root")
    }

    const manifestPath = path.join(packageRoot, "patch-manifest.json")
    const lstat = dependencies.lstat ?? defaultLstat
    let manifestStat: FileStat
    try {
        manifestStat = await lstat(manifestPath)
    } catch (error) {
        if (isMissing(error)) {
            await assertDirectoryUnchanged(
                packageRoot,
                packageRootFingerprint,
                directoryName,
                "patch version directory",
                dependencies,
            )
            await assertDirectoryUnchanged(
                patchesRoot,
                patchesRootFingerprint,
                directoryName,
                "patches root",
                dependencies,
            )
            return null
        }
        throw error
    }
    if (manifestStat.isSymbolicLink()) {
        fail("PATCH_ARCHIVE_SYMLINK", directoryName, "patch manifest is a symbolic link", "patch-manifest.json")
    }
    if (!manifestStat.isFile()) {
        fail("PATCH_ARCHIVE_FILE_TYPE", directoryName, "patch manifest is not a regular file", "patch-manifest.json")
    }

    const physicalManifest = await requiredRealpath(
        manifestPath,
        directoryName,
        "patch manifest",
        "patch-manifest.json",
        dependencies,
    )
    if (!isSameOrDescendant(physicalRoot, physicalManifest)) {
        fail("PATCH_ARCHIVE_SYMLINK", directoryName, "patch manifest resolves outside patch root", "patch-manifest.json")
    }

    let manifestBytes: Buffer
    let manifestValue: unknown
    try {
        manifestBytes = await requiredReadFile(
            manifestPath,
            directoryName,
            "patch-manifest.json",
            dependencies,
        )
        manifestValue = JSON.parse(manifestBytes.toString("utf8"))
    } catch (error) {
        if (error instanceof SyntaxError) {
            fail("PATCH_ARCHIVE_FILE_TYPE", directoryName, "patch manifest is not valid JSON", "patch-manifest.json")
        }
        throw error
    }
    const manifestAfter = await snapshotRelativeComponents(
        packageRoot,
        "patch-manifest.json",
        directoryName,
        dependencies,
    )
    assertSameComponents([manifestStat], manifestAfter, directoryName, "patch-manifest.json")
    const physicalManifestAfter = await requiredRealpath(
        manifestPath,
        directoryName,
        "patch manifest",
        "patch-manifest.json",
        dependencies,
    )
    if (physicalManifestAfter !== physicalManifest) {
        fail("PATCH_ARCHIVE_SYMLINK", directoryName, "patch manifest resolved path changed while scanning", "patch-manifest.json")
    }
    await assertDirectoryUnchanged(
        packageRoot,
        packageRootFingerprint,
        directoryName,
        "patch version directory",
        dependencies,
    )
    await assertDirectoryUnchanged(
        patchesRoot,
        patchesRootFingerprint,
        directoryName,
        "patches root",
        dependencies,
    )
    const manifest = parsePatchManifest(manifestValue)
    if (manifest.targetVersion !== directoryName) {
        fail(
            "PATCH_DIRECTORY_VERSION_MISMATCH",
            directoryName,
            `manifest target ${manifest.targetVersion} does not match directory`,
            "patch-manifest.json",
        )
    }

    const ignoredPaths: string[] = []
    for (const child of await directoryEntries(packageRoot, dependencies)) {
        if (child.isFile() && child.name !== "patch-manifest.json") {
            ignoredPaths.push(`${directoryName}/${child.name}`)
        }
    }
    await assertDirectoryUnchanged(
        packageRoot,
        packageRootFingerprint,
        directoryName,
        "patch version directory",
        dependencies,
    )
    await assertDirectoryUnchanged(
        patchesRoot,
        patchesRootFingerprint,
        directoryName,
        "patches root",
        dependencies,
    )
    if (manifestStat.size < BigInt(0) || manifestStat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        fail("PATCH_ARCHIVE_FILE_TYPE", directoryName, "patch manifest has unsupported metadata", "patch-manifest.json")
    }
    const manifestFingerprint: PatchManifestFingerprint = {
        targetVersion: manifest.targetVersion,
        relativePath: "patch-manifest.json",
        physicalPath: physicalManifest,
        compressedBytes: Number(manifestStat.size),
        mtimeMs: manifestStat.mtimeMs.toString(10),
        ctimeMs: manifestStat.ctimeMs.toString(10),
        dev: manifestStat.dev.toString(10),
        ino: manifestStat.ino.toString(10),
        sha256: createHash("sha256").update(manifestBytes).digest("hex"),
        patchesRoot: patchesRootFingerprint,
        packageRoot: packageRootFingerprint,
    }
    return {
        directoryName,
        packageRoot,
        physicalRoot,
        patchesRootFingerprint,
        packageRootFingerprint,
        manifestFingerprint,
        manifest,
        ignoredPaths,
    }
}

function resolveDependencies(
    packages: readonly DiscoveredPackage[],
    baselineVersion: string,
): readonly DiscoveredPackage[] {
    const available = new Set<string>([baselineVersion])
    const pending = [...packages]
    const ordered: DiscoveredPackage[] = []
    while (pending.length > 0) {
        let progressed = false
        for (let index = 0; index < pending.length;) {
            const candidate = pending[index]
            if (candidate.manifest.baseVersion === null
                || available.has(candidate.manifest.baseVersion)) {
                available.add(candidate.manifest.targetVersion)
                ordered.push(candidate)
                pending.splice(index, 1)
                progressed = true
            } else {
                index++
            }
        }
        if (progressed) continue
        const pendingTargets = new Set(pending.map(candidate => candidate.manifest.targetVersion))
        const missing = pending.find(candidate => (
            candidate.manifest.baseVersion !== null
            && !pendingTargets.has(candidate.manifest.baseVersion)
        ))
        if (missing) {
            fail(
                "PATCH_BASE_VERSION_MISSING",
                missing.manifest.targetVersion,
                `required base ${missing.manifest.baseVersion as string} is not installed`,
            )
        }
        const cycle = pending[0]
        fail("PATCH_BASE_VERSION_CYCLE", cycle.manifest.targetVersion, "patch content dependencies contain a cycle")
    }
    return ordered.sort((left, right) => compareVersions(
        left.manifest.targetVersion,
        right.manifest.targetVersion,
    ))
}

async function scanArchive(
    candidate: DiscoveredPackage,
    archive: PatchManifest["archives"][number],
    dependencies: PatchOverlayDependencies,
): Promise<PatchArchiveScan> {
    const expectedLayer = LAYER_DIRECTORIES[archive.layer]
    const expectedPrefix = `${expectedLayer.directory}/`
    const fileName = path.posix.basename(archive.relativePath)
    if (!archive.relativePath.startsWith(expectedPrefix)
        || archive.relativePath.slice(expectedPrefix.length).includes("/")) {
        fail(
            "PATCH_ARCHIVE_TARGET_MISMATCH",
            candidate.manifest.targetVersion,
            `archive layer ${archive.layer} uses the wrong directory`,
            archive.relativePath,
        )
    }
    const parsed = parseDiffArchiveName(fileName)
    if (!parsed
        || parsed.toVersion !== candidate.manifest.targetVersion
        || parsed.order !== archive.order) {
        fail(
            "PATCH_ARCHIVE_TARGET_MISMATCH",
            candidate.manifest.targetVersion,
            "archive filename version or order does not match manifest",
            archive.relativePath,
        )
    }

    await assertDirectoryUnchanged(
        candidate.packageRoot,
        candidate.packageRootFingerprint,
        candidate.manifest.targetVersion,
        "patch version directory",
        dependencies,
    )
    await assertDirectoryUnchanged(
        path.dirname(candidate.packageRoot),
        candidate.patchesRootFingerprint,
        candidate.manifest.targetVersion,
        "patches root",
        dependencies,
    )
    const beforeComponents = await snapshotRelativeComponents(
        candidate.packageRoot,
        archive.relativePath,
        candidate.manifest.targetVersion,
        dependencies,
    )
    const absolutePath = path.join(candidate.packageRoot, ...archive.relativePath.split("/"))
    const stat = beforeComponents[beforeComponents.length - 1]
    if (stat.size !== BigInt(archive.bytes)) {
        fail("PATCH_ARCHIVE_SIZE_MISMATCH", candidate.manifest.targetVersion, "archive size does not match manifest", archive.relativePath)
    }
    const physicalPath = await requiredRealpath(
        absolutePath,
        candidate.manifest.targetVersion,
        "declared archive",
        archive.relativePath,
        dependencies,
    )
    if (!isSameOrDescendant(candidate.physicalRoot, physicalPath)
        || physicalPath === candidate.physicalRoot) {
        fail("PATCH_ARCHIVE_SYMLINK", candidate.manifest.targetVersion, "archive resolves outside patch root", archive.relativePath)
    }
    const afterComponents = await snapshotRelativeComponents(
        candidate.packageRoot,
        archive.relativePath,
        candidate.manifest.targetVersion,
        dependencies,
    )
    assertSameComponents(
        beforeComponents,
        afterComponents,
        candidate.manifest.targetVersion,
        archive.relativePath,
    )
    const physicalAfter = await requiredRealpath(
        absolutePath,
        candidate.manifest.targetVersion,
        "declared archive",
        archive.relativePath,
        dependencies,
    )
    if (physicalAfter !== physicalPath) {
        fail("PATCH_ARCHIVE_SYMLINK", candidate.manifest.targetVersion, "archive resolved path changed while scanning", archive.relativePath)
    }
    await assertDirectoryUnchanged(
        candidate.packageRoot,
        candidate.packageRootFingerprint,
        candidate.manifest.targetVersion,
        "patch version directory",
        dependencies,
    )
    await assertDirectoryUnchanged(
        path.dirname(candidate.packageRoot),
        candidate.patchesRootFingerprint,
        candidate.manifest.targetVersion,
        "patches root",
        dependencies,
    )
    return deepFreeze({
        source: { kind: "patch", targetVersion: candidate.manifest.targetVersion },
        kind: "diff",
        fromVersion: parsed.fromVersion,
        toVersion: parsed.toVersion,
        platform: "android",
        layer: expectedLayer.catalogLayer,
        order: parsed.order,
        relativePath: archive.relativePath,
        compressedBytes: archive.bytes,
        expectedSha256: archive.sha256,
        physicalPath,
        mtimeMs: stat.mtimeMs.toString(10),
        ctimeMs: stat.ctimeMs.toString(10),
        dev: stat.dev.toString(10),
        ino: stat.ino.toString(10),
    })
}

function sameManifestFingerprint(
    left: PatchManifestFingerprint,
    right: PatchManifestFingerprint,
): boolean {
    return left.targetVersion === right.targetVersion
        && left.relativePath === right.relativePath
        && left.physicalPath === right.physicalPath
        && left.compressedBytes === right.compressedBytes
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs
        && left.dev === right.dev
        && left.ino === right.ino
        && left.sha256 === right.sha256
        && sameDirectoryFingerprint(left.patchesRoot, right.patchesRoot)
        && sameDirectoryFingerprint(left.packageRoot, right.packageRoot)
}

export async function verifyPatchManifestFingerprint(
    patchesRootValue: string,
    expected: PatchManifestFingerprint,
    dependencies: PatchOverlayDependencies = {},
): Promise<void> {
    const patchesRoot = path.resolve(patchesRootValue)
    const currentPatchesRoot = await snapshotDirectory(
        patchesRoot,
        expected.targetVersion,
        "patches root",
        dependencies,
    )
    if (!sameDirectoryFingerprint(expected.patchesRoot, currentPatchesRoot)) {
        fail("PATCH_ARCHIVE_SYMLINK", expected.targetVersion, "patches root identity changed after target scan")
    }

    const packageRoot = path.join(patchesRoot, expected.targetVersion)
    const currentPackageRoot = await snapshotDirectory(
        packageRoot,
        expected.targetVersion,
        "patch version directory",
        dependencies,
    )
    if (!sameDirectoryFingerprint(expected.packageRoot, currentPackageRoot)
        || !isSameOrDescendant(currentPatchesRoot.physicalPath, currentPackageRoot.physicalPath)
        || currentPackageRoot.physicalPath === currentPatchesRoot.physicalPath) {
        fail("PATCH_ARCHIVE_SYMLINK", expected.targetVersion, "patch version directory identity changed after target scan")
    }

    const beforeComponents = await snapshotRelativeComponents(
        packageRoot,
        expected.relativePath,
        expected.targetVersion,
        dependencies,
    )
    const before = beforeComponents[beforeComponents.length - 1]
    const manifestPath = path.join(packageRoot, expected.relativePath)
    const physicalPath = await requiredRealpath(
        manifestPath,
        expected.targetVersion,
        "patch manifest",
        expected.relativePath,
        dependencies,
    )
    if (!isSameOrDescendant(currentPackageRoot.physicalPath, physicalPath)) {
        fail("PATCH_ARCHIVE_SYMLINK", expected.targetVersion, "patch manifest resolves outside patch root", expected.relativePath)
    }
    const manifestBytes = await requiredReadFile(
        manifestPath,
        expected.targetVersion,
        expected.relativePath,
        dependencies,
    )
    const afterComponents = await snapshotRelativeComponents(
        packageRoot,
        expected.relativePath,
        expected.targetVersion,
        dependencies,
    )
    assertSameComponents(beforeComponents, afterComponents, expected.targetVersion, expected.relativePath)
    const physicalAfter = await requiredRealpath(
        manifestPath,
        expected.targetVersion,
        "patch manifest",
        expected.relativePath,
        dependencies,
    )
    if (physicalAfter !== physicalPath) {
        fail("PATCH_ARCHIVE_SYMLINK", expected.targetVersion, "patch manifest resolved path changed while validating", expected.relativePath)
    }
    await assertDirectoryUnchanged(
        packageRoot,
        currentPackageRoot,
        expected.targetVersion,
        "patch version directory",
        dependencies,
    )
    await assertDirectoryUnchanged(
        patchesRoot,
        currentPatchesRoot,
        expected.targetVersion,
        "patches root",
        dependencies,
    )
    if (before.size < BigInt(0) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        fail("PATCH_ARCHIVE_FILE_TYPE", expected.targetVersion, "patch manifest has unsupported metadata", expected.relativePath)
    }
    const actual: PatchManifestFingerprint = {
        targetVersion: expected.targetVersion,
        relativePath: expected.relativePath,
        physicalPath,
        compressedBytes: Number(before.size),
        mtimeMs: before.mtimeMs.toString(10),
        ctimeMs: before.ctimeMs.toString(10),
        dev: before.dev.toString(10),
        ino: before.ino.toString(10),
        sha256: createHash("sha256").update(manifestBytes).digest("hex"),
        patchesRoot: currentPatchesRoot,
        packageRoot: currentPackageRoot,
    }
    if (!sameManifestFingerprint(expected, actual)) {
        fail("PATCH_ARCHIVE_HASH_MISMATCH", expected.targetVersion, "patch manifest identity or content changed after target scan", expected.relativePath)
    }
}

export async function scanPatchOverlay(
    paths: Pick<ContentPaths, "patchesRoot">,
    baselineCatalog: CdnCatalog,
    dependencies: PatchOverlayDependencies = {},
): Promise<PatchOverlayScan> {
    const patchesRoot = path.resolve(paths.patchesRoot)
    const rootEntries = await directoryEntries(patchesRoot, dependencies)
    if (rootEntries.length === 0) {
        return deepFreeze({ archives: [], manifests: [], ignoredPaths: [] })
    }

    const patchesRootFingerprint = await snapshotDirectory(
        patchesRoot,
        "<root>",
        "patches root",
        dependencies,
    )
    const ignoredPaths = rootEntries
        .filter(entry => !entry.isDirectory())
        .map(entry => entry.name)
    const packages: DiscoveredPackage[] = []
    for (const entry of [...rootEntries].sort((left, right) => left.name.localeCompare(right.name))) {
        const candidate = await readPackage(patchesRoot, patchesRootFingerprint, entry, dependencies)
        if (candidate === null) {
            if (entry.isDirectory()) ignoredPaths.push(`${entry.name}/`)
            continue
        }
        ignoredPaths.push(...candidate.ignoredPaths)
        packages.push(candidate)
    }

    const archives: PatchArchiveScan[] = []
    for (const candidate of resolveDependencies(packages, baselineCatalog.targetVersion)) {
        for (const archive of candidate.manifest.archives) {
            archives.push(await scanArchive(candidate, archive, dependencies))
        }
    }
    for (const candidate of packages) {
        await verifyPatchManifestFingerprint(
            patchesRoot,
            candidate.manifestFingerprint,
            dependencies,
        )
    }
    archives.sort((left, right) => (
        compareVersions(left.toVersion, right.toVersion)
        || left.relativePath.localeCompare(right.relativePath)
    ))
    return deepFreeze({
        archives,
        manifests: packages.map(candidate => candidate.manifestFingerprint),
        ignoredPaths: [...new Set(ignoredPaths)].sort((left, right) => left.localeCompare(right)),
    })
}
