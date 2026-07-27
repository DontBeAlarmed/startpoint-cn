import {
    ContentSnapshotError,
    getContentSnapshot,
} from "./content-snapshot"

export function getRuntimeContentTableSync<T>(
    tableName: string,
    bundledBeforeInitialization: T,
): T {
    try {
        return getContentSnapshot().repository.table<T>(tableName)
    } catch (error) {
        if (!(error instanceof ContentSnapshotError)
            || error.code !== "CONTENT_SNAPSHOT_NOT_INITIALIZED") throw error
        return bundledBeforeInitialization
    }
}
