import { getContentSnapshot } from "./content-snapshot"

export function getStrictRuntimeContentTableSync<T>(tableName: string): T {
    return getContentSnapshot().repository.table<T>(tableName)
}
