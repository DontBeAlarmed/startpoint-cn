import type { ContentSourceReference, ContentReleaseManifest } from "./schema"
import { TABLE_SOURCES, type TableSourceDefinition } from "./table-registry"

function sameSources(
    left: readonly ContentSourceReference[],
    right: readonly ContentSourceReference[],
): boolean {
    return left.length === right.length && left.every((value, index) => (
        JSON.stringify(value) === JSON.stringify(right[index])
    ))
}

export function getReleaseTableRegistryError(
    manifest: ContentReleaseManifest,
    definitions: readonly TableSourceDefinition[] = TABLE_SOURCES,
): Error | null {
    const registeredNames = new Set(definitions.map(definition => definition.tableName))
    const releaseNames = Object.keys(manifest.tables)
    const missing = [...registeredNames].filter(tableName => !(tableName in manifest.tables)).sort()
    const extra = releaseNames.filter(tableName => !registeredNames.has(tableName)).sort()
    if (missing.length > 0 || extra.length > 0) {
        const details = [
            ...(missing.length === 0 ? [] : [`missing tables: ${missing.join(", ")}`]),
            ...(extra.length === 0 ? [] : [`extra tables: ${extra.join(", ")}`]),
        ]
        return new Error(`content release tables do not match registry (${details.join("; ")})`)
    }

    for (const definition of definitions) {
        const reference = manifest.tables[definition.tableName]
        if (reference.scope !== definition.scope) {
            return new Error(`content release table ${definition.tableName} has mismatched scope`)
        }
        if (reference.converterId !== definition.converterId) {
            return new Error(`content release table ${definition.tableName} has mismatched converterId`)
        }
        if (reference.converterVersion !== definition.converterVersion) {
            return new Error(`content release table ${definition.tableName} has mismatched converterVersion`)
        }
        if (!sameSources(reference.sources, definition.manifestSources)) {
            return new Error(`content release table ${definition.tableName} has mismatched sources`)
        }
    }
    return null
}

export function assertReleaseTableRegistry(
    manifest: ContentReleaseManifest,
    definitions: readonly TableSourceDefinition[] = TABLE_SOURCES,
): void {
    const error = getReleaseTableRegistryError(manifest, definitions)
    if (error !== null) throw error
}
