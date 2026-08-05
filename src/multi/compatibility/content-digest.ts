import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { canonicalJsonBuffer, sha256Object } from "../../content/sync/canonical-json"

export type Sha256Digest = `sha256:${string}`

function compareCodePoint(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

export function buildBundledContentDigest(
    repository: ReadonlyContentRepository,
    tableNames: readonly string[],
): Sha256Digest {
    const identities = [...tableNames]
        .sort(compareCodePoint)
        .map(tableName => ({
            tableName,
            digest: sha256Object(canonicalJsonBuffer(repository.table(tableName))),
        }))
    return sha256Object(canonicalJsonBuffer(identities))
}

export function resolveContentDigest(
    repository: ReadonlyContentRepository,
    tableNames: readonly string[],
): Sha256Digest {
    return repository.info().releaseDigest
        ?? buildBundledContentDigest(repository, tableNames)
}
