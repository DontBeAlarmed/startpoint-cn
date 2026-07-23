import fs from "node:fs"
import path from "node:path"

function isSameOrDescendant(parent: string, candidate: string): boolean {
    const relativePath = path.relative(parent, candidate)
    return relativePath === ""
        || (!path.isAbsolute(relativePath)
            && relativePath !== ".."
            && !relativePath.startsWith(`..${path.sep}`))
}

function requireRelativePath(relativePath: string, label: string): string {
    if (!relativePath
        || relativePath.includes("\\")
        || path.posix.isAbsolute(relativePath)
        || path.win32.isAbsolute(relativePath)
        || path.posix.normalize(relativePath) !== relativePath
        || relativePath === ".."
        || relativePath.startsWith("../")) {
        throw new Error(`${label} has an invalid runtime-relative path`)
    }
    return relativePath
}

export async function readContentRuntimeFile(
    contentRuntimeDir: string,
    relativePath: string,
    label: string,
): Promise<Buffer> {
    const runtimeRoot = path.resolve(contentRuntimeDir)
    const sourcePath = path.resolve(runtimeRoot, requireRelativePath(relativePath, label))
    if (!isSameOrDescendant(runtimeRoot, sourcePath)) {
        throw new Error(`${label} is outside runtime root`)
    }

    let physicalRuntimeRoot: string
    let physicalSourcePath: string
    try {
        [physicalRuntimeRoot, physicalSourcePath] = await Promise.all([
            fs.promises.realpath(runtimeRoot),
            fs.promises.realpath(sourcePath),
        ])
    } catch {
        throw new Error(`cannot read ${label}`)
    }
    if (!isSameOrDescendant(physicalRuntimeRoot, physicalSourcePath)) {
        throw new Error(`${label} resolves outside runtime root through a symlink`)
    }

    let fileHandle: fs.promises.FileHandle
    try {
        fileHandle = await fs.promises.open(
            physicalSourcePath,
            fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
        )
    } catch {
        throw new Error(`cannot safely open ${label}; symlink or changed file`)
    }

    try {
        const openedStat = await fileHandle.stat()
        const verifiedSourcePath = await fs.promises.realpath(physicalSourcePath)
        if (!isSameOrDescendant(physicalRuntimeRoot, verifiedSourcePath)) {
            throw new Error(`${label} changed to a path outside runtime root`)
        }
        const verifiedStat = await fs.promises.stat(verifiedSourcePath)
        if (!openedStat.isFile()
            || !verifiedStat.isFile()
            || openedStat.dev !== verifiedStat.dev
            || openedStat.ino !== verifiedStat.ino) {
            throw new Error(`${label} changed while opening`)
        }
        return await fileHandle.readFile()
    } catch {
        throw new Error(`cannot safely read ${label}; symlink or changed file`)
    } finally {
        try {
            await fileHandle.close()
        } catch {
            throw new Error(`cannot safely close ${label}`)
        }
    }
}

export async function readContentRuntimeText(
    contentRuntimeDir: string,
    relativePath: string,
    label: string,
): Promise<string> {
    return (await readContentRuntimeFile(contentRuntimeDir, relativePath, label)).toString("utf8")
}
