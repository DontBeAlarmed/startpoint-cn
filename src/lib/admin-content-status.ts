import { BUNDLED_CDN_CATALOG_VERSION } from "../content/constants"
import type { AssetProviderConfig } from "../content/cdn/asset-mode"
import type { ContentSnapshot } from "../content/runtime/content-snapshot"
import { deepFreeze } from "../content/deep-freeze"

const DATA_SCOPE = ["items", "characters", "events", "quests", "shops"] as const

export interface AdminContentStatusOptions {
    readonly snapshot: ContentSnapshot
    readonly assetProvider: AssetProviderConfig
    readonly configuredCdnDir: string
}

function compareVersions(left: string, right: string): number {
    const leftParts = left.split(".").map(Number)
    const rightParts = right.split(".").map(Number)
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
        const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
        if (difference !== 0) return difference
    }
    return 0
}

export function buildAdminContentStatus({
    snapshot,
    assetProvider,
    configuredCdnDir,
}: AdminContentStatusOptions) {
    const archiveBytesByPath = new Map<string, number>()
    for (const edge of snapshot.cdn.edges) {
        for (const archive of edge.archives) {
            archiveBytesByPath.set(archive.relativePath, archive.compressedBytes)
        }
    }

    const patchVersions = [...new Set(snapshot.archiveSources.archives.flatMap(entry => (
        entry.source.kind === "patch" ? [entry.source.targetVersion] : []
    )))].sort(compareVersions)
    const patchArchiveCount = snapshot.archiveSources.archives.filter(
        entry => entry.source.kind === "patch",
    ).length
    const archiveBytes = snapshot.archiveSources.archives.reduce(
        (total, entry) => total + (archiveBytesByPath.get(entry.relativePath) ?? 0),
        0,
    )
    const repository = snapshot.repository.info()
    const runtimeEnabled = patchVersions.length > 0
    const storageMode = assetProvider.mode

    const baseline = {
        mode: "official-cn-overlay",
        source: "国服最终 CDN",
        fullVersion: snapshot.cdn.fullBaseVersion,
        cnFinalVersion: BUNDLED_CDN_CATALOG_VERSION,
        detectedArchiveVersion: snapshot.cdn.targetVersion,
        manifestVersion: repository.assetVersion,
        pinned: true,
        dataScope: [...DATA_SCOPE],
    }
    const extension = {
        mode: "manifest-overlay",
        status: runtimeEnabled ? "active" : "empty",
        runtimeEnabled,
        effectiveVersionPreview: snapshot.cdn.targetVersion,
        enabledPatchCount: patchVersions.length,
        totalPatchCount: patchVersions.length,
        activePatchArchiveCount: patchArchiveCount,
        versions: patchVersions,
        note: runtimeEnabled
            ? "补丁已进入当前固定 Content Snapshot。"
            : "当前固定 Content Snapshot 未包含补丁。",
    }
    const storage = {
        mode: storageMode,
        configuredDir: configuredCdnDir,
        directoryPresent: storageMode === "local",
        archiveCount: snapshot.archiveSources.archives.length,
        archiveBytes,
        latestArchiveMtime: null,
    }
    return deepFreeze({
        baseUrl: assetProvider.mode === "client-owned" ? null : assetProvider.baseUrl,
        baseline,
        extension,
        storage,
        contentRelease: repository,
        // Temporary flat fields retained for older admin clients.
        configuredDir: storage.configuredDir,
        directoryPresent: storage.directoryPresent,
        archiveCount: storage.archiveCount,
        archiveBytes: storage.archiveBytes,
        latestArchiveMtime: storage.latestArchiveMtime,
        fullVersion: baseline.fullVersion,
        detectedVersion: baseline.detectedArchiveVersion,
        effectiveVersion: extension.effectiveVersionPreview,
        manifestVersion: baseline.manifestVersion,
        enabledPatchCount: extension.enabledPatchCount,
        totalPatchCount: extension.totalPatchCount,
        activePatchArchiveCount: extension.activePatchArchiveCount,
    })
}
