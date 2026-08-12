import type { FastifyInstance } from "fastify"

import { deepFreeze } from "../content/deep-freeze"
import type { ContentSnapshot } from "../content/runtime/content-snapshot"
import { canonicalJsonBuffer, sha256Object } from "../content/sync/canonical-json"
import {
    MODE_API_VERSION,
    MODE_SERVER_CAPABILITIES,
    type LoadedModeIdentity,
} from "../modes/registry"
import type { BundleMetadata } from "./bundle-metadata"

const SHA256_IDENTITY = /^sha256:[0-9a-f]{64}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const CAPABILITY = /^[a-z0-9][a-z0-9._-]*@[1-9][0-9]*$/

export interface RuntimeCapabilitiesInput {
    readonly bundle: BundleMetadata
    readonly content: ContentSnapshot
    readonly loadedModes: readonly LoadedModeIdentity[]
    readonly node: string
    readonly nodeAbi: string
    readonly platform: NodeJS.Platform
    readonly arch: string
}

export interface RuntimeCapabilitiesBody {
    readonly contractVersion: 1
    readonly serverCapabilities: readonly string[]
    readonly serverBundle: {
        readonly version: string
        readonly bundleId: string | null
    }
    readonly runtime: {
        readonly api: 1
        readonly node: string
        readonly nodeAbi: string
        readonly platform: NodeJS.Platform
        readonly arch: string
    }
    readonly content: {
        readonly source: "bundled" | "release"
        readonly assetVersion: string
        readonly generatorVersion: number
        readonly releaseDigest: `sha256:${string}` | null
        readonly contentDigest: `sha256:${string}`
        readonly cdnTargetVersion: string
        readonly patchVersions: readonly string[]
    }
    readonly modes: {
        readonly api: 1
        readonly serverCapabilities: readonly string[]
        readonly loaded: readonly {
            readonly name: string
            readonly capabilities: readonly string[]
            readonly sha256: string
        }[]
        readonly modeDigest: `sha256:${string}`
    }
    readonly features: {
        readonly patchOverlaySchema: 1
        readonly modeChangesRequireRestart: true
        readonly activeContentManagement: false
    }
}

function compareCodePoint(left: string, right: string): number {
    const leftCodePoints = Array.from(left, character => character.codePointAt(0)!)
    const rightCodePoints = Array.from(right, character => character.codePointAt(0)!)
    const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length)
    for (let index = 0; index < sharedLength; index += 1) {
        if (leftCodePoints[index] !== rightCodePoints[index]) {
            return leftCodePoints[index] - rightCodePoints[index]
        }
    }
    return leftCodePoints.length - rightCodePoints.length
}

function compareVersions(left: string, right: string): number {
    const leftParts = left.split(".").map(Number)
    const rightParts = right.split(".").map(Number)
    for (let index = 0; index < 3; index += 1) {
        const difference = leftParts[index] - rightParts[index]
        if (difference !== 0) return difference
    }
    return 0
}

function compareLoadedModes(left: LoadedModeIdentity, right: LoadedModeIdentity): number {
    return compareCodePoint(left.fileName, right.fileName)
        || compareCodePoint(left.name, right.name)
}

function validateLoadedMode(identity: LoadedModeIdentity): void {
    if (!identity.name
        || !identity.fileName.endsWith(".mjs")
        || /[\0/\\]/.test(identity.fileName)
        || !SHA256_HEX.test(identity.sha256)
        || identity.capabilities.length === 0
        || identity.capabilities.some(capability => !CAPABILITY.test(capability))
        || new Set(identity.capabilities).size !== identity.capabilities.length) {
        throw new TypeError("loaded mode identity is invalid")
    }
}

function buildModeDigest(identities: readonly LoadedModeIdentity[]): `sha256:${string}` {
    const canonicalIdentities = [...identities]
        .sort(compareLoadedModes)
        .map(identity => ({
            fileName: identity.fileName,
            name: identity.name,
            capabilities: [...identity.capabilities],
            sha256: identity.sha256,
        }))
    return sha256Object(canonicalJsonBuffer(canonicalIdentities))
}

export function createRuntimeCapabilitiesSnapshot(
    input: RuntimeCapabilitiesInput,
): RuntimeCapabilitiesBody {
    if (!DECIMAL.test(input.nodeAbi)) {
        throw new TypeError("nodeAbi must be a decimal ABI number")
    }
    if (input.bundle.bundleId !== null && !SHA256_IDENTITY.test(input.bundle.bundleId)) {
        throw new TypeError("bundleId must be null or a SHA-256 identity")
    }
    input.loadedModes.forEach(validateLoadedMode)
    const repository = input.content.repository.info()
    if (!SHA256_IDENTITY.test(repository.contentDigest)
        || (repository.releaseDigest !== null
            && !SHA256_IDENTITY.test(repository.releaseDigest))) {
        throw new TypeError("content identities must be SHA-256 values")
    }
    const patchVersions = [...new Set(input.content.archiveSources.archives.flatMap(entry => (
        entry.source.kind === "patch" ? [entry.source.targetVersion] : []
    )))]
    if (patchVersions.some(version => !VERSION.test(version))) {
        throw new TypeError("patch versions must be three-part numeric versions")
    }
    patchVersions.sort(compareVersions)
    const loadedModes = [...input.loadedModes].sort(compareLoadedModes)
    const serverCapabilities = [...new Set([
        "content.sync@1",
        ...MODE_SERVER_CAPABILITIES,
    ])].sort(compareCodePoint)

    return deepFreeze({
        contractVersion: 1,
        serverCapabilities,
        serverBundle: {
            version: input.bundle.version,
            bundleId: input.bundle.bundleId,
        },
        runtime: {
            api: MODE_API_VERSION,
            node: input.node,
            nodeAbi: input.nodeAbi,
            platform: input.platform,
            arch: input.arch,
        },
        content: {
            source: repository.source,
            assetVersion: repository.assetVersion,
            generatorVersion: repository.generatorVersion,
            releaseDigest: repository.releaseDigest,
            contentDigest: repository.contentDigest,
            cdnTargetVersion: input.content.cdn.targetVersion,
            patchVersions,
        },
        modes: {
            api: MODE_API_VERSION,
            serverCapabilities: [...MODE_SERVER_CAPABILITIES],
            loaded: loadedModes.map(identity => ({
                name: identity.name,
                capabilities: [...identity.capabilities],
                sha256: identity.sha256,
            })),
            modeDigest: buildModeDigest(input.loadedModes),
        },
        features: {
            patchOverlaySchema: 1,
            modeChangesRequireRestart: true,
            activeContentManagement: false,
        },
    })
}

export function registerRuntimeCapabilitiesRoute(
    fastify: FastifyInstance,
    getSnapshot: () => RuntimeCapabilitiesBody,
): void {
    fastify.get("/api/server/capabilities", (_request, reply) => {
        reply.type("application/json").status(200).send(getSnapshot())
    })
}
