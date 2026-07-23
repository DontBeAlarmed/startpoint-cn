import { deepFreeze } from "../deep-freeze"
import { readContentRuntimeText } from "../runtime/runtime-file-reader"
import { findTableSource } from "./table-registry"

function runtimeRelativePath(bundledPath: string, tableName: string): string {
    const prefix = "assets/"
    if (!bundledPath.startsWith(prefix)) {
        throw new Error(`registered source is outside runtime root: ${tableName}`)
    }
    const relativePath = bundledPath.slice(prefix.length)
    if (!relativePath) {
        throw new Error(`registered source is outside runtime root: ${tableName}`)
    }
    return relativePath
}

export async function importBundledTable(
    contentRuntimeDir: string,
    tableName: string,
): Promise<unknown> {
    const definition = findTableSource(tableName)
    const text = await readContentRuntimeText(
        contentRuntimeDir,
        runtimeRelativePath(definition.bundledPath, tableName),
        `bundled table ${tableName}`,
    )

    try {
        return deepFreeze(JSON.parse(text) as unknown)
    } catch {
        throw new Error(`invalid JSON in bundled table ${tableName}`)
    }
}
