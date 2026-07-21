import fs from "node:fs"
import path from "node:path"

import { deepFreeze } from "../deep-freeze"
import { findTableSource } from "./table-registry"

function isSameOrDescendant(parent: string, candidate: string): boolean {
    const relativePath = path.relative(parent, candidate)
    return relativePath === ""
        || (!path.isAbsolute(relativePath)
            && relativePath !== ".."
            && !relativePath.startsWith(`..${path.sep}`))
}

export async function importBundledTable(projectRoot: string, tableName: string): Promise<unknown> {
    const definition = findTableSource(tableName)

    const root = path.resolve(projectRoot)
    const assetsRoot = path.resolve(root, "assets")
    const sourcePath = path.resolve(root, definition.bundledPath)
    if (!isSameOrDescendant(assetsRoot, sourcePath)) {
        throw new Error(`registered source is outside assets: ${tableName}`)
    }

    let physicalAssetsRoot: string
    let physicalSourcePath: string
    try {
        [physicalAssetsRoot, physicalSourcePath] = await Promise.all([
            fs.promises.realpath(assetsRoot),
            fs.promises.realpath(sourcePath),
        ])
    } catch {
        throw new Error(`cannot read bundled table ${tableName}`)
    }
    if (!isSameOrDescendant(physicalAssetsRoot, physicalSourcePath)) {
        throw new Error(`bundled table resolves outside assets through a symlink: ${tableName}`)
    }

    let fileHandle: fs.promises.FileHandle
    try {
        const noFollow = fs.constants.O_NOFOLLOW ?? 0
        fileHandle = await fs.promises.open(
            physicalSourcePath,
            fs.constants.O_RDONLY | noFollow,
        )
    } catch {
        throw new Error(`cannot safely open bundled table ${tableName}; symlink or changed file`)
    }

    let text: string
    try {
        const openedStat = await fileHandle.stat()
        const verifiedSourcePath = await fs.promises.realpath(physicalSourcePath)
        if (!isSameOrDescendant(physicalAssetsRoot, verifiedSourcePath)) {
            throw new Error(`bundled table changed to a path outside assets: ${tableName}`)
        }
        const verifiedStat = await fs.promises.stat(verifiedSourcePath)
        if (!openedStat.isFile()
            || !verifiedStat.isFile()
            || openedStat.dev !== verifiedStat.dev
            || openedStat.ino !== verifiedStat.ino) {
            throw new Error(`bundled table changed while opening: ${tableName}`)
        }
        text = await fileHandle.readFile({ encoding: "utf8" })
    } catch {
        throw new Error(`cannot safely read bundled table ${tableName}; symlink or changed file`)
    } finally {
        try {
            await fileHandle.close()
        } catch {
            throw new Error(`cannot safely close bundled table ${tableName}`)
        }
    }

    try {
        return deepFreeze(JSON.parse(text) as unknown)
    } catch {
        throw new Error(`invalid JSON in bundled table ${tableName}`)
    }
}
