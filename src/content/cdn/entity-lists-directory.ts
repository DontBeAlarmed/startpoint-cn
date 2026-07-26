import fs from "node:fs"
import path from "node:path"

export const ENTITY_LISTS_DIRECTORY_NAMES = ["EntityLists", "entities"] as const

export interface EntityListsDirectoryDependencies {
    readonly lstat?: typeof fs.promises.lstat
}

export async function resolveEntityListsDirectoryName(
    cdnRoot: string,
    dependencies: EntityListsDirectoryDependencies = {},
): Promise<(typeof ENTITY_LISTS_DIRECTORY_NAMES)[number]> {
    const lstat = dependencies.lstat ?? fs.promises.lstat
    for (const directoryName of ENTITY_LISTS_DIRECTORY_NAMES) {
        try {
            await lstat(path.join(cdnRoot, directoryName))
            return directoryName
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
    }
    return "EntityLists"
}
