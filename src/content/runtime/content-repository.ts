import path from "node:path"

import { mapWithConcurrency } from "../concurrency"
import { BUNDLED_CDN_CATALOG_VERSION } from "../constants"
import { deepFreeze } from "../deep-freeze"
import {
    resolveContentPaths,
    type ContentPathEnvironment,
} from "../paths"
import { importBundledTable as defaultImportBundledTable } from "../sync/bundled-importer"
import { ContentObjectStore } from "../sync/object-store"
import {
    CONTENT_GENERATOR_VERSION,
} from "../sync/schema"
import type { ContentCurrentReleaseSnapshot } from "../sync/object-store"
import { findTableSource, TABLE_SOURCES } from "../sync/table-registry"
import { assertReleaseTableRegistry } from "../sync/table-contract"
import { canonicalJsonBuffer, sha256Object } from "../sync/canonical-json"
import {
    buildMultiBattleContentDigest,
    buildMultiBattleContentDigestFromObjects,
} from "./multi-battle-digest"

type ContentDigest = `sha256:${string}`

export interface ContentRepositoryInfo {
    readonly source: "bundled" | "release"
    readonly assetVersion: string
    readonly generatorVersion: number
    readonly releaseDigest: `sha256:${string}` | null
    readonly contentDigest: ContentDigest
    readonly multiBattleContentDigest: ContentDigest
}

export interface ContentRepositoryOptions {
    readonly projectRoot: string
    readonly env?: ContentPathEnvironment
}

export interface ContentRepositoryDependencies {
    readonly importBundledTable?: typeof defaultImportBundledTable
}

const BUNDLED_IMPORT_CONCURRENCY = 8

function compareCodePoint(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

function digestBundledEntries(entries: readonly (readonly [string, unknown])[]): ContentDigest {
    const identities = entries
        .map(([tableName, value]) => ({
            tableName,
            digest: sha256Object(canonicalJsonBuffer(value)),
        }))
        .sort((left, right) => compareCodePoint(left.tableName, right.tableName))
    return sha256Object(canonicalJsonBuffer(identities))
}

export class ContentRepository {
    readonly #repositoryInfo: ContentRepositoryInfo
    readonly #tables: Readonly<Record<string, unknown>>

    private constructor(
        repositoryInfo: ContentRepositoryInfo,
        tables: Readonly<Record<string, unknown>>,
    ) {
        this.#repositoryInfo = repositoryInfo
        this.#tables = tables
    }

    static async load(
        options: ContentRepositoryOptions,
        dependencies: ContentRepositoryDependencies = {},
    ): Promise<ContentRepository> {
        if (!options.projectRoot || !path.isAbsolute(options.projectRoot)) {
            throw new TypeError("projectRoot must be an absolute path")
        }
        const projectRoot = path.resolve(options.projectRoot)
        const paths = resolveContentPaths({
            projectRoot,
            env: options.env ?? process.env,
        })
        const store = new ContentObjectStore(paths)
        const release = await store.readCurrentReleaseSnapshot()

        return this.loadFromSnapshot(options, release, dependencies, paths)
    }

    static async loadFromSnapshot(
        options: ContentRepositoryOptions,
        release: ContentCurrentReleaseSnapshot | null,
        dependencies: ContentRepositoryDependencies = {},
        resolvedPaths?: Pick<ReturnType<typeof resolveContentPaths>, "contentRuntimeDir">,
    ): Promise<ContentRepository> {
        if (!options.projectRoot || !path.isAbsolute(options.projectRoot)) {
            throw new TypeError("projectRoot must be an absolute path")
        }
        const projectRoot = path.resolve(options.projectRoot)
        const paths = resolvedPaths ?? resolveContentPaths({
            projectRoot,
            env: options.env ?? process.env,
        })

        if (release === null) {
            const importer = dependencies.importBundledTable ?? defaultImportBundledTable
            const entries = await mapWithConcurrency(
                TABLE_SOURCES,
                BUNDLED_IMPORT_CONCURRENCY,
                async definition => (
                    [
                        definition.tableName,
                        await importer(paths.contentRuntimeDir, definition.tableName),
                    ] as const
                ),
            )
            const tables = deepFreeze(Object.fromEntries(entries))
            const contentDigest = digestBundledEntries(entries)
            return deepFreeze(new ContentRepository(
                deepFreeze({
                    source: "bundled",
                    assetVersion: BUNDLED_CDN_CATALOG_VERSION,
                    generatorVersion: CONTENT_GENERATOR_VERSION,
                    releaseDigest: null,
                    contentDigest,
                    multiBattleContentDigest: buildMultiBattleContentDigest(tables),
                }),
                tables,
            ))
        }

        assertReleaseTableRegistry(release.manifest)
        const entries = TABLE_SOURCES.map(definition => (
            [
                definition.tableName,
                release.objects[release.manifest.tables[definition.tableName].object],
            ] as const
        ))
        const tables = deepFreeze(Object.fromEntries(entries))
        return deepFreeze(new ContentRepository(
            deepFreeze({
                source: "release",
                assetVersion: release.manifest.assetVersion,
                generatorVersion: release.manifest.generatorVersion,
                releaseDigest: release.manifest.releaseDigest,
                contentDigest: release.manifest.releaseDigest,
                multiBattleContentDigest: buildMultiBattleContentDigestFromObjects(
                    Object.fromEntries(Object.entries(release.manifest.tables).map(
                        ([tableName, table]) => [tableName, table.object],
                    )),
                ),
            }),
            tables,
        ))
    }

    info(): ContentRepositoryInfo {
        return this.#repositoryInfo
    }

    table<T>(tableName: string): T {
        findTableSource(tableName)
        return this.#tables[tableName] as T
    }
}
