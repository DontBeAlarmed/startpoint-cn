import path from "node:path"

import { deepFreeze } from "../deep-freeze"
import { CdnCatalogLoader } from "../cdn/catalog-loader"
import type { CdnCatalog } from "../cdn/types"
import {
    ContentRepository,
    type ContentRepositoryInfo,
} from "./content-repository"

export interface ReadonlyContentRepository {
    info(): ContentRepositoryInfo
    table<T>(tableName: string): T
}

export interface ContentSnapshot {
    readonly cdn: CdnCatalog
    readonly repository: ReadonlyContentRepository
}

export type ContentSnapshotErrorCode = "CONTENT_SNAPSHOT_NOT_INITIALIZED"

export class ContentSnapshotError extends Error {
    readonly code: ContentSnapshotErrorCode

    constructor(code: ContentSnapshotErrorCode, message: string) {
        super(`${code}: ${message}`)
        this.name = "ContentSnapshotError"
        this.code = code
    }
}

export class ContentSnapshotSourcesError extends Error {
    readonly errors: readonly unknown[]

    constructor(errors: readonly unknown[]) {
        super("content catalog and repository sources both failed")
        this.name = "ContentSnapshotSourcesError"
        this.errors = Object.freeze([...errors])
    }
}

export interface ContentCatalogSource {
    load(): Promise<CdnCatalog>
}

export interface ContentRepositorySource {
    load(): Promise<ReadonlyContentRepository>
}

export interface ContentSnapshotProviderOptions {
    readonly catalogSource: ContentCatalogSource
    readonly repositorySource: ContentRepositorySource
}

export function resolveContentProjectRoot(moduleDirectory: string): string {
    return path.resolve(moduleDirectory, "../../..")
}

type Settled<T> =
    | { readonly status: "fulfilled"; readonly value: T }
    | { readonly status: "rejected"; readonly reason: unknown }

function settle<T>(load: () => Promise<T>): Promise<Settled<T>> {
    let pending: Promise<T>
    try {
        pending = load()
    } catch (reason) {
        return Promise.resolve({ status: "rejected", reason })
    }
    return pending.then(
        value => ({ status: "fulfilled", value }),
        reason => ({ status: "rejected", reason }),
    )
}

export class ContentSnapshotProvider {
    private readonly catalogSource: ContentCatalogSource
    private readonly repositorySource: ContentRepositorySource
    private snapshot: ContentSnapshot | null = null
    private initialization: Promise<ContentSnapshot> | null = null

    constructor({ catalogSource, repositorySource }: ContentSnapshotProviderOptions) {
        this.catalogSource = catalogSource
        this.repositorySource = repositorySource
    }

    initialize(): Promise<ContentSnapshot> {
        if (this.snapshot) return Promise.resolve(this.snapshot)
        if (this.initialization) return this.initialization

        const initialization = Promise.all([
            settle(() => this.catalogSource.load()),
            settle(() => this.repositorySource.load()),
        ])
            .then(([catalogResult, repositoryResult]) => {
                const errors: unknown[] = []
                if (catalogResult.status === "rejected") errors.push(catalogResult.reason)
                if (repositoryResult.status === "rejected") errors.push(repositoryResult.reason)
                if (errors.length === 1) throw errors[0]
                if (errors.length === 2) throw new ContentSnapshotSourcesError(errors)
                if (catalogResult.status !== "fulfilled"
                    || repositoryResult.status !== "fulfilled") {
                    throw new Error("content snapshot source settlement is inconsistent")
                }
                return deepFreeze({
                    cdn: catalogResult.value,
                    repository: repositoryResult.value,
                })
            })
            .then(snapshot => {
                this.snapshot = snapshot
                return snapshot
            })
        this.initialization = initialization
        void initialization.then(
            () => {
                if (this.initialization === initialization) this.initialization = null
            },
            () => {
                if (this.initialization === initialization) this.initialization = null
            },
        )
        return initialization
    }

    get(): ContentSnapshot {
        if (!this.snapshot) {
            throw new ContentSnapshotError(
                "CONTENT_SNAPSHOT_NOT_INITIALIZED",
                "content snapshot has not been initialized",
            )
        }
        return this.snapshot
    }
}

export const productionCatalogLoader = new CdnCatalogLoader({
    projectRoot: resolveContentProjectRoot(__dirname),
})

export const productionRepositorySource: ContentRepositorySource = Object.freeze({
    load: () => ContentRepository.load({
        projectRoot: resolveContentProjectRoot(__dirname),
    }),
})

export const productionContentSnapshotProvider = new ContentSnapshotProvider({
    catalogSource: productionCatalogLoader,
    repositorySource: productionRepositorySource,
})

export function initializeContentSnapshot(): Promise<ContentSnapshot> {
    return productionContentSnapshotProvider.initialize()
}

export function getContentSnapshot(): ContentSnapshot {
    return productionContentSnapshotProvider.get()
}
