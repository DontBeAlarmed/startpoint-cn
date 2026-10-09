import type { IncomingHttpHeaders } from "node:http"

import {
    ContentSnapshotError,
    getContentSnapshot,
    type ContentSnapshot,
} from "../../content/runtime/content-snapshot"
import { listLoadedModeIdentities } from "../../modes/registry"
import {
    MULTI_PROTOCOL_VERSION,
    type CoordinatorResult,
    type MultiCompatibilityProfile,
} from "../coordinator/contracts"
import type { Sha256Digest } from "./content-digest"
import { buildModeDigest, type LoadedModeIdentity } from "./mode-digest"

const PROFILE_FIELDS = Object.freeze([
    "multiProtocolVersion",
    "APP_VER",
    "RES_VER",
    "cdnTargetVersion",
    "contentDigest",
    "modeDigest",
] as const)
const BLOCKING_PROFILE_FIELDS = new Set<typeof PROFILE_FIELDS[number]>([
    "multiProtocolVersion",
    "APP_VER",
    "contentDigest",
    "modeDigest",
])
const VERSION_HEADER_PATTERN = /^[\x21-\x7e]{1,64}$/
const UNKNOWN_RESOURCE_VERSION = "unknown"

export interface CompatibilityProfileSource {
    readonly cdnTargetVersion: string
    readonly contentDigest: Sha256Digest
    readonly modeDigest: Sha256Digest
}

export interface CompatibilityProfileDependencies {
    readonly getContentSnapshot?: () => ContentSnapshot
    readonly getLoadedModeIdentities?: () => readonly LoadedModeIdentity[]
    readonly source?: CompatibilityProfileSource
    readonly onCompatibilityRejection?: (input: {
        readonly code: "INCOMPATIBLE_ROOM"
        readonly differences: readonly []
    }) => void
}

export interface CompatibilityDifference {
    readonly field: typeof PROFILE_FIELDS[number]
    readonly host: string | number
    readonly guest: string | number
}

export interface CompatibilityComparison {
    readonly compatible: boolean
    readonly differences: readonly CompatibilityDifference[]
}

type CompatibilityHeaders = IncomingHttpHeaders & {
    readonly APP_VER?: string | readonly string[]
    readonly RES_VER?: string | readonly string[]
}

function readVersionHeader(
    headers: CompatibilityHeaders,
    name: "APP_VER" | "RES_VER",
): string | null {
    const value = headers[name] ?? headers[name.toLowerCase()]
    return typeof value === "string" && VERSION_HEADER_PATTERN.test(value)
        ? value
        : null
}

function resolveProfileSource(
    dependencies: CompatibilityProfileDependencies,
    snapshot?: ContentSnapshot,
): CompatibilityProfileSource {
    if (dependencies.source) return Object.freeze({ ...dependencies.source })
    const resolved = snapshot ?? (dependencies.getContentSnapshot ?? getContentSnapshot)()
    return Object.freeze({
        cdnTargetVersion: resolved.cdn.targetVersion,
        contentDigest: resolved.repository.info().multiBattleContentDigest,
        modeDigest: buildModeDigest(
            (dependencies.getLoadedModeIdentities ?? listLoadedModeIdentities)(),
        ),
    })
}

export function createCompatibilityProfileFactory(
    dependencies: CompatibilityProfileDependencies = {},
): (headers: CompatibilityHeaders) => CoordinatorResult<MultiCompatibilityProfile> {
    // 显式注入的 source 是调用方的固定选择，保持一次解析；
    // 从快照派生的缓存按快照实例比较——内容热重载（provider.reload 换新
    // 快照实例）后自动重算，避免对外宣告的 contentDigest 滞留旧值。
    let cachedFor: ContentSnapshot | null = null
    let cachedSource = dependencies.source
        ? resolveProfileSource(dependencies)
        : null
    return headers => {
        const APP_VER = readVersionHeader(headers, "APP_VER")
        const RES_VER = readVersionHeader(headers, "RES_VER") ?? UNKNOWN_RESOURCE_VERSION
        if (APP_VER === null) {
            dependencies.onCompatibilityRejection?.({
                code: "INCOMPATIBLE_ROOM",
                differences: [],
            })
            return { ok: false, error: "INCOMPATIBLE_ROOM" }
        }
        // 每请求取当前快照实例（内容热重载换实例后缓存自动重算，对外
        // contentDigest 不滞留旧值）。取值在 try 内：快照未初始化期间保持
        // 受控 INCOMPATIBLE_ROOM（不得向 multi 请求逸出 500）。
        try {
            const currentSnapshot = dependencies.source
                ? cachedFor
                : (dependencies.getContentSnapshot ?? getContentSnapshot)()
            if (cachedSource === null || cachedFor !== currentSnapshot) {
                cachedSource = resolveProfileSource(dependencies, currentSnapshot ?? undefined)
                cachedFor = currentSnapshot
            }
        } catch (error) {
            if (error instanceof ContentSnapshotError
                && error.code === "CONTENT_SNAPSHOT_NOT_INITIALIZED") {
                dependencies.onCompatibilityRejection?.({
                    code: "INCOMPATIBLE_ROOM",
                    differences: [],
                })
                return { ok: false, error: "INCOMPATIBLE_ROOM" }
            }
            throw error
        }
        return {
            ok: true,
            value: Object.freeze({
                multiProtocolVersion: MULTI_PROTOCOL_VERSION,
                APP_VER,
                RES_VER,
                ...cachedSource,
            }),
        }
    }
}

export function compareCompatibility(
    host: MultiCompatibilityProfile,
    guest: MultiCompatibilityProfile,
): CompatibilityComparison {
    const differences: CompatibilityDifference[] = []
    for (const field of PROFILE_FIELDS) {
        if (host[field] === guest[field]) continue
        differences.push({ field, host: host[field], guest: guest[field] })
    }
    return Object.freeze({
        compatible: differences.every(difference => !BLOCKING_PROFILE_FIELDS.has(difference.field)),
        differences: Object.freeze(differences),
    })
}
