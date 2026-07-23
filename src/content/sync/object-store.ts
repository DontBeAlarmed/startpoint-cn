import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { mapWithConcurrency } from "../concurrency"
import { deepFreeze } from "../deep-freeze"
import type { ContentPaths } from "../paths"
import { canonicalJsonBuffer, sha256Object } from "./canonical-json"
import {
    createReleaseManifest,
    parseCurrentPointer,
    parseReleaseManifest,
    type ContentCurrentPointer,
    type ContentReleaseManifest,
} from "./schema"

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const RELEASE_PATH_PATTERN = /^releases\/(.+)-([0-9a-f]{64})\/manifest\.json$/
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0
const OBJECT_READ_CONCURRENCY = 8
const SPLIT_ROOT_CONFLICT_MESSAGE = "contentStoreDir and contentStateDir must not be equal or nested"

interface FileIdentity {
    readonly dev: number
    readonly ino: number
    readonly size: number
    readonly mtimeMs: number
    readonly ctimeMs: number
}

interface DirectoryIdentity {
    readonly filePath: string
    readonly dev: number
    readonly ino: number
}

export interface ContentObjectStoreDependencies {
    readonly rename?: (source: string, destination: string) => Promise<void>
}

type ModernContentObjectStorePaths = Pick<ContentPaths, "contentStoreDir" | "contentStateDir">
type LegacyContentObjectStorePaths = Pick<ContentPaths, "contentRootDir">
type ContentObjectStorePaths = ContentPaths
    | ModernContentObjectStorePaths
    | LegacyContentObjectStorePaths

export interface ContentCurrentRelease {
    readonly current: ContentCurrentPointer
    readonly manifest: ContentReleaseManifest
}

export interface ContentReleaseSnapshot {
    readonly manifest: ContentReleaseManifest
    readonly objects: Readonly<Record<`sha256:${string}`, unknown>>
}

export interface ContentCurrentReleaseSnapshot extends ContentCurrentRelease {
    readonly objects: Readonly<Record<`sha256:${string}`, unknown>>
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
    return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT")
}

function resolvePhysicalProjection(filePath: string, label: string): string {
    const missingSegments: string[] = []
    let existingAncestor = filePath

    while (!fs.existsSync(existingAncestor)) {
        try {
            if (fs.lstatSync(existingAncestor).isSymbolicLink()) {
                throw new TypeError(
                    `${label} contains a dangling symbolic link: ${existingAncestor}`,
                )
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== "ENOENT" && code !== "ENOTDIR") throw error
        }
        const parent = path.dirname(existingAncestor)
        if (parent === existingAncestor) {
            throw new TypeError(`cannot find an existing ancestor for ${label}`)
        }
        missingSegments.unshift(path.basename(existingAncestor))
        existingAncestor = parent
    }

    return path.resolve(fs.realpathSync(existingAncestor), ...missingSegments)
}

function errorWithCause(message: string, cause: unknown): Error {
    const error = new Error(message) as Error & { cause?: unknown }
    error.cause = cause
    return error
}

function identityOf(stat: fs.Stats): FileIdentity {
    return {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
    }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino
}

function assertDigest(digest: string): asserts digest is `sha256:${string}` {
    if (!DIGEST_PATTERN.test(digest)) {
        throw new TypeError("object digest must be a lowercase prefixed SHA-256 digest")
    }
}

function relativeReleasePath(manifest: ContentReleaseManifest): string {
    return `releases/${manifest.assetVersion}-${manifest.releaseDigest.slice("sha256:".length)}/manifest.json`
}

function referencedObjects(manifest: ContentReleaseManifest): ReadonlySet<`sha256:${string}`> {
    const digests = new Set<`sha256:${string}`>([
        manifest.catalog.object,
        manifest.summary.object,
    ])
    for (const table of Object.values(manifest.tables)) digests.add(table.object)
    return digests
}

export class ContentObjectStore {
    private readonly contentStoreDir: string
    private readonly contentStateDir: string
    private readonly rename: (source: string, destination: string) => Promise<void>
    readonly #directoryIdentities = new Map<string, DirectoryIdentity>()

    constructor(
        paths: ContentObjectStorePaths,
        dependencies: ContentObjectStoreDependencies = {},
    ) {
        const resolved = ContentObjectStore.resolveRoots(paths)
        this.contentStoreDir = resolved.contentStoreDir
        this.contentStateDir = resolved.contentStateDir
        this.rename = dependencies.rename ?? ((source, destination) => (
            fs.promises.rename(source, destination)
        ))
    }

    private static resolveRoots(paths: ContentObjectStorePaths): ModernContentObjectStorePaths {
        const candidate = paths as Partial<ContentPaths>
        const hasRoot = candidate.contentRootDir !== undefined
        const hasStore = candidate.contentStoreDir !== undefined
        const hasState = candidate.contentStateDir !== undefined

        if (hasStore !== hasState) {
            throw new TypeError("contentStoreDir and contentStateDir must be configured together")
        }
        if (hasRoot && hasStore) {
            if (!this.isCompleteContentPaths(candidate)) {
                throw new TypeError(
                    "legacy contentRootDir cannot be mixed with split roots outside complete ContentPaths",
                )
            }
            if (candidate.layout === "modern") {
                return this.requireIsolatedSplitRoots(candidate)
            }
            const root = this.requireAbsoluteRoot(candidate.contentRootDir)
            const split = this.requireAbsoluteSplitRoots(candidate)
            if (root === split.contentStoreDir && root === split.contentStateDir) {
                return { contentStoreDir: root, contentStateDir: root }
            }
            throw new TypeError("legacy contentRootDir cannot be mixed with split contentStoreDir/contentStateDir")
        }
        if (hasStore) return this.requireIsolatedSplitRoots(candidate)
        if (hasRoot) {
            if (candidate.layout !== undefined) {
                throw new TypeError("layout requires complete ContentPaths")
            }
            const root = this.requireAbsoluteRoot(candidate.contentRootDir)
            return { contentStoreDir: root, contentStateDir: root }
        }
        throw new TypeError("content store paths must use split roots or an explicit legacy contentRootDir")
    }

    private static isCompleteContentPaths(paths: Partial<ContentPaths>): paths is ContentPaths {
        return (paths.layout === "modern" || paths.layout === "legacy")
            && [
                paths.cdnDir,
                paths.cdnRoot,
                paths.contentRootDir,
                paths.contentStoreDir,
                paths.contentStateDir,
                paths.contentRuntimeDir,
            ].every(value => typeof value === "string" && value.length > 0)
    }

    private static requireAbsoluteRoot(root: string | undefined): string {
        if (!root || !path.isAbsolute(root)) {
            throw new TypeError("contentRootDir must be an absolute path")
        }
        return path.resolve(root)
    }

    private static requireAbsoluteSplitRoots(
        paths: Partial<ModernContentObjectStorePaths>,
    ): ModernContentObjectStorePaths {
        if (!paths.contentStoreDir || !path.isAbsolute(paths.contentStoreDir)) {
            throw new TypeError("contentStoreDir must be an absolute path")
        }
        if (!paths.contentStateDir || !path.isAbsolute(paths.contentStateDir)) {
            throw new TypeError("contentStateDir must be an absolute path")
        }
        return {
            contentStoreDir: path.resolve(paths.contentStoreDir),
            contentStateDir: path.resolve(paths.contentStateDir),
        }
    }

    private static requireIsolatedSplitRoots(
        paths: Partial<ModernContentObjectStorePaths>,
    ): ModernContentObjectStorePaths {
        const resolved = this.requireAbsoluteSplitRoots(paths)
        const physicalStoreDir = resolvePhysicalProjection(
            resolved.contentStoreDir,
            "contentStoreDir",
        )
        const physicalStateDir = resolvePhysicalProjection(
            resolved.contentStateDir,
            "contentStateDir",
        )
        const stateFromStore = path.relative(
            physicalStoreDir,
            physicalStateDir,
        )
        const storeFromState = path.relative(
            physicalStateDir,
            physicalStoreDir,
        )
        if (this.isSameOrDescendant(stateFromStore)
            || this.isSameOrDescendant(storeFromState)) {
            throw new TypeError(SPLIT_ROOT_CONFLICT_MESSAGE)
        }
        return resolved
    }

    private static isSameOrDescendant(relativePath: string): boolean {
        return relativePath === ""
            || (relativePath !== ".."
                && !relativePath.startsWith(`..${path.sep}`)
                && !path.isAbsolute(relativePath))
    }

    async writeObject(value: unknown): Promise<`sha256:${string}`> {
        const bytes = canonicalJsonBuffer(value)
        const digest = sha256Object(bytes)
        const objectsDirectory = await this.secureManagedDirectory("objects", true)
        const objectPath = path.join(objectsDirectory.filePath, `${digest.slice(7)}.json`)

        await this.atomicWrite(objectsDirectory, objectPath, bytes, false)
        return digest
    }

    async readObject(digest: string): Promise<unknown> {
        assertDigest(digest)
        let bytes: Buffer
        try {
            const objectsDirectory = await this.secureManagedDirectory("objects", false)
            const objectPath = path.join(objectsDirectory.filePath, `${digest.slice(7)}.json`)
            bytes = await this.secureReadFile(objectsDirectory, objectPath, `object ${digest}`)
        } catch (error) {
            if (isMissing(error)) throw errorWithCause(`content object is missing: ${digest}`, error)
            throw error
        }

        try {
            const value: unknown = JSON.parse(bytes.toString("utf8"))
            const canonical = canonicalJsonBuffer(value)
            if (!bytes.equals(canonical)) throw new Error("stored bytes are not canonical JSON")
            if (sha256Object(canonical) !== digest) throw new Error("digest does not match stored bytes")
            return deepFreeze(value)
        } catch (error) {
            throw errorWithCause(`content object is corrupt: ${digest}`, error)
        }
    }

    async writeRelease(
        input: Omit<ContentReleaseManifest, "releaseDigest">,
    ): Promise<ContentReleaseManifest> {
        const manifest = createReleaseManifest(input)
        for (const digest of referencedObjects(manifest)) await this.readObject(digest)

        const location = this.parseReleaseLocation(relativeReleasePath(manifest))
        const releasesDirectory = await this.secureManagedDirectory("releases", true)
        const releaseDirectory = await this.secureChildDirectory(
            releasesDirectory,
            location.directoryName,
            true,
        )
        const manifestPath = path.join(releaseDirectory.filePath, "manifest.json")
        await this.atomicWrite(
            releaseDirectory,
            manifestPath,
            canonicalJsonBuffer(manifest),
            false,
        )
        return manifest
    }

    async readCurrent(): Promise<ContentCurrentPointer | null> {
        return (await this.readCurrentRelease())?.current ?? null
    }

    async readCurrentRelease(): Promise<ContentCurrentRelease | null> {
        const snapshot = await this.readCurrentReleaseSnapshot()
        if (snapshot === null) return null
        return Object.freeze({ current: snapshot.current, manifest: snapshot.manifest })
    }

    async readCurrentReleaseSnapshot(): Promise<ContentCurrentReleaseSnapshot | null> {
        const current = await this.readCurrentPointer()
        if (current === null) return null
        const release = await this.readReleaseSnapshot(current)
        return deepFreeze({
            current,
            manifest: release.manifest,
            objects: release.objects,
        })
    }

    private async readCurrentPointer(): Promise<ContentCurrentPointer | null> {
        let root: DirectoryIdentity
        try {
            root = await this.secureStateRoot(false)
        } catch (error) {
            if (isMissing(error)) return null
            throw error
        }

        let bytes: Buffer
        try {
            bytes = await this.secureReadFile(
                root,
                path.join(this.contentStateDir, "current.json"),
                "current pointer",
            )
        } catch (error) {
            if (isMissing(error)) return null
            throw error
        }

        let current: ContentCurrentPointer
        try {
            current = parseCurrentPointer(JSON.parse(bytes.toString("utf8")))
            if (!bytes.equals(canonicalJsonBuffer(current))) {
                throw new Error("stored bytes are not canonical JSON")
            }
        } catch (error) {
            throw errorWithCause("current pointer is corrupt", error)
        }
        return current
    }

    async readRelease(
        pointerOrManifestPath: ContentCurrentPointer | string,
    ): Promise<ContentReleaseManifest> {
        return (await this.readReleaseSnapshot(pointerOrManifestPath)).manifest
    }

    async readReleaseSnapshot(
        pointerOrManifestPath: ContentCurrentPointer | string,
    ): Promise<ContentReleaseSnapshot> {
        const location = this.releaseLocationFromInput(pointerOrManifestPath)
        let bytes: Buffer
        try {
            const releasesDirectory = await this.secureManagedDirectory("releases", false)
            const releaseDirectory = await this.secureChildDirectory(
                releasesDirectory,
                location.directoryName,
                false,
            )
            const manifestPath = path.join(releaseDirectory.filePath, "manifest.json")
            bytes = await this.secureReadFile(releaseDirectory, manifestPath, "release manifest")
        } catch (error) {
            if (isMissing(error)) {
                throw errorWithCause(`release manifest is missing: ${location.relativePath}`, error)
            }
            throw error
        }

        let manifest: ContentReleaseManifest
        try {
            manifest = parseReleaseManifest(JSON.parse(bytes.toString("utf8")))
            if (!bytes.equals(canonicalJsonBuffer(manifest))) {
                throw new Error("stored bytes are not canonical JSON")
            }
        } catch (error) {
            throw errorWithCause(`release manifest is corrupt: ${location.relativePath}`, error)
        }
        if (manifest.assetVersion !== location.assetVersion
            || manifest.releaseDigest.slice(7) !== location.digest) {
            throw new Error(`release manifest does not match its path: ${location.relativePath}`)
        }
        const objectEntries = await mapWithConcurrency(
            [...referencedObjects(manifest)],
            OBJECT_READ_CONCURRENCY,
            async digest => [digest, await this.readObject(digest)] as const,
        )
        return deepFreeze({
            manifest,
            objects: Object.fromEntries(objectEntries) as Record<`sha256:${string}`, unknown>,
        })
    }

    async activate(manifest: ContentReleaseManifest): Promise<ContentCurrentPointer> {
        const parsed = parseReleaseManifest(manifest)
        const release = relativeReleasePath(parsed)
        const stored = await this.readRelease(release)
        if (!canonicalJsonBuffer(stored).equals(canonicalJsonBuffer(parsed))) {
            throw new Error("release manifest does not match stored manifest")
        }

        const current = parseCurrentPointer({
            schemaVersion: parsed.schemaVersion,
            assetVersion: parsed.assetVersion,
            release,
        })
        const root = await this.secureStateRoot(true)
        await this.atomicWrite(
            root,
            path.join(this.contentStateDir, "current.json"),
            canonicalJsonBuffer(current),
            true,
        )
        return current
    }

    private async secureStoreRoot(create: boolean): Promise<DirectoryIdentity> {
        if (create) await fs.promises.mkdir(this.contentStoreDir, { recursive: true, mode: 0o700 })
        return this.secureDirectory(this.contentStoreDir, "content store root")
    }

    private async secureStateRoot(create: boolean): Promise<DirectoryIdentity> {
        if (create) await fs.promises.mkdir(this.contentStateDir, { recursive: true, mode: 0o700 })
        return this.secureDirectory(this.contentStateDir, "content state root")
    }

    private async secureManagedDirectory(
        name: "objects" | "releases",
        create: boolean,
    ): Promise<DirectoryIdentity> {
        const root = await this.secureStoreRoot(create)
        return this.secureChildDirectory(root, name, create)
    }

    private async secureChildDirectory(
        parent: DirectoryIdentity,
        name: string,
        create: boolean,
    ): Promise<DirectoryIdentity> {
        if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
            throw new Error(`invalid managed directory name: ${name}`)
        }
        await this.assertDirectoryStable(parent)
        const childPath = path.join(parent.filePath, name)
        if (create) {
            try {
                await fs.promises.mkdir(childPath, { mode: 0o700 })
            } catch (error) {
                if (!(error && typeof error === "object"
                    && (error as NodeJS.ErrnoException).code === "EEXIST")) throw error
            }
        }
        const child = await this.secureDirectory(childPath, `managed directory ${name}`)
        await this.assertDirectoryStable(parent)
        return child
    }

    private async secureDirectory(filePath: string, label: string): Promise<DirectoryIdentity> {
        const before = await fs.promises.lstat(filePath)
        if (before.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${filePath}`)
        if (!before.isDirectory()) throw new Error(`${label} is not a directory: ${filePath}`)

        let handle: fs.promises.FileHandle | undefined
        try {
            handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW)
            const opened = await handle.stat()
            if (!opened.isDirectory()) throw new Error(`${label} is not a directory: ${filePath}`)
            const identity = { filePath, dev: opened.dev, ino: opened.ino }
            if (before.dev !== identity.dev || before.ino !== identity.ino) {
                throw new Error(`${label} changed while it was opened: ${filePath}`)
            }
            const remembered = this.#directoryIdentities.get(filePath)
            if (remembered && !sameDirectoryIdentity(remembered, identity)) {
                throw new Error(`${label} was replaced during store lifetime: ${filePath}`)
            }
            this.#directoryIdentities.set(filePath, identity)
            return identity
        } finally {
            await handle?.close()
        }
    }

    private async assertDirectoryStable(identity: DirectoryIdentity): Promise<void> {
        const current = await this.secureDirectory(identity.filePath, "managed parent directory")
        if (!sameDirectoryIdentity(identity, current)) {
            throw new Error(`managed parent directory changed: ${identity.filePath}`)
        }
    }

    private async secureReadFile(
        parent: DirectoryIdentity,
        filePath: string,
        label: string,
    ): Promise<Buffer> {
        await this.assertDirectoryStable(parent)
        const beforeStat = await fs.promises.lstat(filePath)
        if (beforeStat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${filePath}`)
        if (!beforeStat.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`)
        const before = identityOf(beforeStat)

        let handle: fs.promises.FileHandle | undefined
        try {
            handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | NOFOLLOW)
            const opened = await handle.stat()
            if (!opened.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`)
            if (!sameFileIdentity(before, identityOf(opened))) {
                throw new Error(`${label} changed while it was opened: ${filePath}`)
            }
            const bytes = await handle.readFile()
            const after = await handle.stat()
            if (!sameFileIdentity(identityOf(opened), identityOf(after))) {
                throw new Error(`${label} changed while it was read: ${filePath}`)
            }
            await this.assertDirectoryStable(parent)
            return bytes
        } finally {
            await handle?.close()
        }
    }

    private async atomicWrite(
        parent: DirectoryIdentity,
        targetPath: string,
        bytes: Buffer,
        replace: boolean,
    ): Promise<void> {
        let targetExists = true
        try {
            const existing = await this.secureReadFile(parent, targetPath, "atomic write target")
            if (!replace) {
                if (!existing.equals(bytes)) {
                    throw new Error(`existing immutable file is corrupt: ${targetPath}`)
                }
                return
            }
        } catch (error) {
            if (!isMissing(error)) throw error
            targetExists = false
        }
        if (replace && targetExists) await this.assertDirectoryStable(parent)

        const temporaryPath = path.join(
            parent.filePath,
            `.${path.basename(targetPath)}.tmp-${randomBytes(16).toString("hex")}`,
        )
        let handle: fs.promises.FileHandle | undefined
        let renamed = false
        try {
            handle = await fs.promises.open(
                temporaryPath,
                fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
                0o600,
            )
            await handle.writeFile(bytes)
            await handle.sync()
            await handle.close()
            handle = undefined
            await this.assertDirectoryStable(parent)
            await this.rename(temporaryPath, targetPath)
            renamed = true
            if (replace) return
            await this.assertDirectoryStable(parent)
            const stored = await this.secureReadFile(parent, targetPath, "atomic write target")
            if (!stored.equals(bytes)) throw new Error(`atomic write verification failed: ${targetPath}`)
        } finally {
            await handle?.close()
            if (!renamed) {
                try {
                    await fs.promises.unlink(temporaryPath)
                } catch (error) {
                    if (!isMissing(error)) throw error
                }
            }
        }
    }

    private releaseLocationFromInput(
        pointerOrManifestPath: ContentCurrentPointer | string,
    ): {
        readonly assetVersion: string
        readonly digest: string
        readonly directoryName: string
        readonly relativePath: string
    } {
        if (typeof pointerOrManifestPath !== "string") {
            return this.parseReleaseLocation(parseCurrentPointer(pointerOrManifestPath).release)
        }

        let relativePath = pointerOrManifestPath
        if (path.isAbsolute(relativePath)) {
            const relative = path.relative(this.contentStoreDir, path.resolve(relativePath))
            if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                throw new Error("release manifest path escapes contentStoreDir")
            }
            relativePath = relative.split(path.sep).join("/")
        }
        return this.parseReleaseLocation(relativePath)
    }

    private parseReleaseLocation(relativePath: string): {
        readonly assetVersion: string
        readonly digest: string
        readonly directoryName: string
        readonly relativePath: string
    } {
        const match = RELEASE_PATH_PATTERN.exec(relativePath)
        if (!match) throw new TypeError("invalid release manifest path")
        const [, assetVersion, digest] = match
        const current = parseCurrentPointer({
            schemaVersion: 1,
            assetVersion,
            release: relativePath,
        })
        return {
            assetVersion: current.assetVersion,
            digest,
            directoryName: `${assetVersion}-${digest}`,
            relativePath: current.release,
        }
    }
}
