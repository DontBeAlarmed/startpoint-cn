

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import enAndroidFull from "../../../assets/asset_lists/en-android-full.json";
import enAndroidShort from "../../../assets/asset_lists/en-android-short.json";
import enIOSFull from "../../../assets/asset_lists/en-ios-full.json";
import koAndroidFull from "../../../assets/asset_lists/ko-android-full.json";
import koAndroidShort from "../../../assets/asset_lists/ko-android-short.json";
import koIOSFull from "../../../assets/asset_lists/ko-ios-full.json";
import thAndroidFull from "../../../assets/asset_lists/th-android-full.json";
import thAndroidShort from "../../../assets/asset_lists/th-android-short.json";
import thIOSFull from "../../../assets/asset_lists/th-ios-full.json";
import { Platform, generateDataHeaders, getRequestPlatformSync } from "../../utils";
import { existsSync } from "fs";
import path from "path";
import { resolveRuntimeDataPaths } from "../../runtime/data-paths";
import {
    LegacyAssetArchive,
    LegacyAssetMetadata,
    loadLegacyAssetState,
} from "./legacy-asset-state";

interface GetPathBody {
    target_asset_version: string,
    viewer_id: number
}

type PathListArchive = LegacyAssetArchive

interface PathList {
    info: {
        client_asset_version?: string,
        target_asset_version: string,
        eventual_target_asset_version: string,
        is_initial: boolean,
        latest_maj_first_version: string
    },
    full: {
        version: string,
        archive: readonly PathListArchive[]
    },
    diff: Object[],
    asset_version_hash: string
}

type CDNMetadata = LegacyAssetMetadata

/**
 * Gets a base path list for a platform & language.
 * 
 * @param platform 
 * @param lang 
 * @param full Whether the path list should be for the partial or full sizes.
 * @returns 
 */
function getBasePathList(
    platform: Platform,
    lang: string,
    full: boolean
): PathList {
    switch (platform) {
        case Platform.ANDROID:
            switch (lang) {
                case "ko":
                    return full || !koShortAvailable ? koAndroidFull : koAndroidShort
                case "th":
                    return full || !thShortAvailable ? thAndroidFull : thAndroidShort
                default:
                    return full || !enShortAvailable ? enAndroidFull : enAndroidShort
            }
        case Platform.IOS:
            switch (lang) {
                case "ko":
                    return koIOSFull
                case "th":
                    return thIOSFull
                default:
                    return enIOSFull
            }
    }
}

/**
 * Generates a CDN version string from a version number.
 * 
 * @param version 
 * @returns 
 */
function getCDNVersionString(
    version: number
): string {
    return `2.1.${version}`
}

// check whether short CDNs are available.
const envCdnDir = process.env.CDN_DIR || ".cdn"
const cdnDir = path.isAbsolute(envCdnDir) ? envCdnDir : path.join(__dirname, "..", "..", "..", envCdnDir)
const enShortAvailable = existsSync(path.join(cdnDir, "en", "entities", "files"))
const koShortAvailable = existsSync(path.join(cdnDir, "ko", "entities", "files"))
const thShortAvailable = existsSync(path.join(cdnDir, "th", "entities", "files"))

// metadata
const runtimeDataPaths = resolveRuntimeDataPaths(
    process.env,
    path.resolve(__dirname, "../../.."),
)
let cdnMetadata: CDNMetadata = {
    version: 125,
    mods: []
}

const latestMajFirstVersion: string = "2.1.0"
export let availableAssetVersion = getCDNVersionString(cdnMetadata.version);

export function getLegacyAvailableAssetVersion(): string {
    return availableAssetVersion
}

export function initializeLegacyAssetState(): void {
    const state = loadLegacyAssetState({
        cdnDir,
        assetProviderDir: runtimeDataPaths.assetProviderDir,
        metadataFile: runtimeDataPaths.legacyAssetMetadataFile,
    })
    cdnMetadata = state.metadata
    availableAssetVersion = state.availableAssetVersion
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/version_info", async (request: FastifyRequest, reply: FastifyReply) => {
        const platform = getRequestPlatformSync(request)
        const deviceLang = request.headers['device_lang'] || 'en'

        let baseUrl = ''
        let filesList = ''
        let totalSize = 0
        let delayedAssetsSize = 0

        switch (platform) {
            case Platform.ANDROID:
                switch (deviceLang) {
                    case "ko":
                        baseUrl = '{$cdnAddress}/ko/entities/files/'
                        filesList = '{$cdnAddress}/ko/entities/2.1.121-android_medium.csv'
                        totalSize = 8846079322
                        delayedAssetsSize = 6919955738
                        break;
                    case "th":
                        baseUrl = '{$cdnAddress}/th/entities/files/'
                        filesList = '{$cdnAddress}/th/entities/2.1.124-android_medium.csv'
                        totalSize = 8846063872
                        delayedAssetsSize = 6919955738
                        break;
                    default:
                        baseUrl = '{$cdnAddress}/en/entities/files/'
                        filesList = '{$cdnAddress}/en/entities/2.1.125-android_medium.csv'
                        totalSize = 8846063846
                        delayedAssetsSize = 6919955738
                }
                break;
            case Platform.IOS:
                switch (deviceLang) {
                    case "ko":
                        baseUrl = '{$cdnAddress}/ko/entities/files/'
                        filesList = '{$cdnAddress}/ko/entities/2.1.121-ios_medium.csv'
                        totalSize = 7928642125
                        delayedAssetsSize = 6362644965
                        break;
                    case "th":
                        baseUrl = '{$cdnAddress}/th/entities/files/'
                        filesList = '{$cdnAddress}/th/entities/2.1.124-ios_medium.csv'
                        totalSize = 7928642125
                        delayedAssetsSize = 6362644965
                        break;
                    default:
                        baseUrl = '{$cdnAddress}/en/entities/files/'
                        filesList = '{$cdnAddress}/en/entities/2.1.125-ios_medium.csv'
                        totalSize = 7928642125
                        delayedAssetsSize = 6362644965
                }
                break;
        }

        reply.header("content-type", "application/x-msgpack")
        reply.status(200).send({
            "data_headers": generateDataHeaders(),
            "data": {
                "base_url": baseUrl,
                "files_list": filesList,
                "total_size": totalSize,
                "delayed_assets_size": delayedAssetsSize
            }
        })
    })

    fastify.post("/get_path", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetPathBody
        const deviceLang = request.headers['device_lang']
        const sizeHeader = request.headers['asset_size']
        const currentVersionHeader = request.headers['res_ver']
        if (!deviceLang) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid headers provided."
        })

        // get the platform that this request originates from.
        const platform = getRequestPlatformSync(request)
        const sendFull = sizeHeader === 'fulfill'

        const headers = generateDataHeaders({
            viewer_id: body.viewer_id,
            asset_update: true
        })

        reply.header("content-type", "application/x-msgpack")
        reply.status(200)
        if (currentVersionHeader !== undefined && (currentVersionHeader !== availableAssetVersion)) {
            // update required, not initial
            const pathList: PathList = {
                info: {
                    client_asset_version: String(currentVersionHeader),
                    target_asset_version: availableAssetVersion,
                    eventual_target_asset_version: availableAssetVersion,
                    is_initial: false,
                    latest_maj_first_version: latestMajFirstVersion
                },
                full: {
                    version: availableAssetVersion,
                    archive: cdnMetadata.mods
                },
                diff: [],
                asset_version_hash: ""
            }

            return reply.send({
                "data_headers": headers,
                "data": pathList
            })
        } else {
            // send
            return reply.send({
                "data_headers": headers,
                "data": getBasePathList(platform, String(deviceLang), sendFull)
            })
        }
    })
}

export default routes;
