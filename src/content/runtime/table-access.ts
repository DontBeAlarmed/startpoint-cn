import {
    ContentSnapshotError,
    getContentSnapshot,
} from "./content-snapshot"

export function getStrictRuntimeContentTableSync<T>(tableName: string): T {
    return getContentSnapshot().repository.table<T>(tableName)
}

/**
 * D27 migration-only compatibility accessor. Production consumers must move
 * to a typed adapter backed by getStrictRuntimeContentTableSync().
 */
export function getRuntimeContentTableSync<T>(
    tableName: string,
    bundledBeforeInitialization: T,
): T {
    let snapshot
    try {
        snapshot = getContentSnapshot()
    } catch (error) {
        if (!(error instanceof ContentSnapshotError)
            || error.code !== "CONTENT_SNAPSHOT_NOT_INITIALIZED") throw error
        return bundledBeforeInitialization
    }
    return snapshot.repository.table<T>(tableName)
}
