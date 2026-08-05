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
const VERSION_HEADER_PATTERN = /^[\x21-\x7e]{1,64}$/

export interface CompatibilityProfileSource {
    readonly cdnTargetVersion: string
    readonly contentDigest: Sha256Digest
    readonly modeDigest: Sha256Digest
}

export interface CompatibilityProfileDependencies {
    readonly getContentSnapshot?: () => ContentSnapshot
    readonly getLoadedModeIdentities?: () => readonly LoadedModeIdentity[]
    readonly source?: CompatibilityProfileSource
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
): CompatibilityProfileSource {
    if (dependencies.source) return Object.freeze({ ...dependencies.source })
    const snapshot = (dependencies.getContentSnapshot ?? getContentSnapshot)()
    return Object.freeze({
        cdnTargetVersion: snapshot.cdn.targetVersion,
        contentDigest: snapshot.repository.info().contentDigest,
        modeDigest: buildModeDigest(
            (dependencies.getLoadedModeIdentities ?? listLoadedModeIdentities)(),
        ),
    })
}

export function createCompatibilityProfileFactory(
    dependencies: CompatibilityProfileDependencies = {},
): (headers: CompatibilityHeaders) => CoordinatorResult<MultiCompatibilityProfile> {
    let cachedSource = dependencies.source
        ? resolveProfileSource(dependencies)
        : null
    return headers => {
        const APP_VER = readVersionHeader(headers, "APP_VER")
        const RES_VER = readVersionHeader(headers, "RES_VER")
        if (APP_VER === null || RES_VER === null) {
            return { ok: false, error: "INCOMPATIBLE_ROOM" }
        }
        if (cachedSource === null) {
            try {
                cachedSource = resolveProfileSource(dependencies)
            } catch (error) {
                if (error instanceof ContentSnapshotError
                    && error.code === "CONTENT_SNAPSHOT_NOT_INITIALIZED") {
                    return { ok: false, error: "INCOMPATIBLE_ROOM" }
                }
                throw error
            }
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
        compatible: differences.length === 0,
        differences: Object.freeze(differences),
    })
}
