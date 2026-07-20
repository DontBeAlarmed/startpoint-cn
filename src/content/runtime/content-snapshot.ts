import path from "node:path"

import { deepFreeze } from "../deep-freeze"
import { CdnCatalogLoader } from "../cdn/catalog-loader"
import type { CdnCatalog } from "../cdn/types"

export interface ContentSnapshot {
    readonly cdn: CdnCatalog
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

export interface ContentCatalogSource {
    load(): Promise<CdnCatalog>
}

export function resolveContentProjectRoot(moduleDirectory: string): string {
    return path.resolve(moduleDirectory, "../../..")
}

export class ContentSnapshotProvider {
    private readonly catalogSource: ContentCatalogSource
    private snapshot: ContentSnapshot | null = null
    private initialization: Promise<ContentSnapshot> | null = null

    constructor(catalogSource: ContentCatalogSource) {
        this.catalogSource = catalogSource
    }

    initialize(): Promise<ContentSnapshot> {
        if (this.snapshot) return Promise.resolve(this.snapshot)
        if (this.initialization) return this.initialization

        const initialization = this.catalogSource.load()
            .then(cdn => deepFreeze({ cdn }))
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

export const productionContentSnapshotProvider = new ContentSnapshotProvider(productionCatalogLoader)

export function initializeContentSnapshot(): Promise<ContentSnapshot> {
    return productionContentSnapshotProvider.initialize()
}

export function getContentSnapshot(): ContentSnapshot {
    return productionContentSnapshotProvider.get()
}
