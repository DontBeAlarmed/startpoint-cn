import type {
    ContentReleaseManifest,
    TableScope,
} from "./schema"

type CreateReleaseInput = Parameters<typeof import("./schema").createReleaseManifest>[0]

function assertSchemaContracts(
    manifest: ContentReleaseManifest,
    input: CreateReleaseInput,
): void {
    const bundled: TableScope = "bundled"

    // @ts-expect-error TableScope is a closed union.
    const invalidScope: TableScope = "client"
    // @ts-expect-error Parsed manifest contracts are readonly.
    manifest.assetVersion = "1.4.56"
    // @ts-expect-error releaseDigest is computed by createReleaseManifest.
    const invalidInput: CreateReleaseInput = { ...input, releaseDigest: "sha256:invalid" }

    void bundled
    void invalidScope
    void invalidInput
}

void assertSchemaContracts
