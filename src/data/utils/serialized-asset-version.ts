const LEGACY_AVAILABLE_ASSET_VERSION = "2.1.125"
let configuredProvider: () => string = () => LEGACY_AVAILABLE_ASSET_VERSION

export function configureSerializedAssetVersionProvider(provider: () => string): void {
    configuredProvider = provider
}

export function resolveSerializedAssetVersion(explicitVersion?: string): string {
    return explicitVersion ?? configuredProvider()
}
