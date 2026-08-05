import { canonicalJsonBuffer, sha256Object } from "../../content/sync/canonical-json"
import type { Sha256Digest } from "./content-digest"

export interface LoadedModeIdentity {
    readonly fileName: string
    readonly name: string
    readonly capability: string
    readonly sha256: string
}

function compareIdentity(left: LoadedModeIdentity, right: LoadedModeIdentity): number {
    return left.fileName < right.fileName ? -1
        : left.fileName > right.fileName ? 1
            : left.name < right.name ? -1
                : left.name > right.name ? 1
                    : 0
}

export function buildModeDigest(identities: readonly LoadedModeIdentity[]): Sha256Digest {
    return sha256Object(canonicalJsonBuffer([...identities].sort(compareIdentity)))
}
