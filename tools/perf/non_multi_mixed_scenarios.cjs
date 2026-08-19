"use strict"

const {
    createMissionProgressSummary,
} = require("./mission_engine_focused_helpers.cjs")
const {
    postCnRequest,
    requireSuccessfulCnResponse,
} = require("./non_multi_mixed_http.cjs")
const {
    executeSingleBattleScenario,
} = require("./non_multi_mixed_battle.cjs")
const { executeGachaScenario } = require("./non_multi_mixed_gacha.cjs")
const { executeMailScenario } = require("./non_multi_mixed_mail.cjs")
const { executeShopScenario } = require("./non_multi_mixed_shop.cjs")
const {
    createActiveMissionBehaviorSummary,
} = require("./active-mission/workload-overlay.cjs")

const LOAD_RES_VERSION = "1.4.54"
const VIEWER_SESSION_TYPE = 2

function isPlainObject(value) {
    if (value === null || typeof value !== "object") return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function countCollection(value) {
    if (Array.isArray(value)) return value.length
    if (value !== null && typeof value === "object") return Object.keys(value).length
    return 0
}

function requireLoadCollection(data, field, { alias, arrayOnly = false } = {}) {
    const selectedField = Object.prototype.hasOwnProperty.call(data, field) ? field : alias
    const value = selectedField === undefined ? undefined : data[selectedField]
    const valid = arrayOnly
        ? Array.isArray(value)
        : Array.isArray(value) || isPlainObject(value)
    if (!valid) {
        throw new Error(
            `load ${field} must be ${arrayOnly ? "an array" : "an array or plain object"}`,
        )
    }
    return value
}

function isValidMissionProgressElement(value) {
    return isPlainObject(value)
        && Number.isSafeInteger(value.mission_category)
        && value.mission_category > 0
        && Number.isSafeInteger(value.mission_id)
        && value.mission_id > 0
        && Number.isSafeInteger(value.progress_value)
        && value.progress_value >= 0
        && Number.isSafeInteger(value.stage)
        && value.stage > 0
}

function validAuthState(state) {
    return state !== null
        && typeof state === "object"
        && state.binding !== null
        && typeof state.binding === "object"
        && Array.isArray(state.viewerSessions)
}

function hasExpectedViewerSession(state, identity) {
    if (!validAuthState(state) || state.viewerSessions.length !== 1) return false
    const [session] = state.viewerSessions
    return session.token === String(identity.viewerId)
        && session.type === VIEWER_SESSION_TYPE
        && session.account_id === identity.accountId
}

async function executeAuth(app, identity, context) {
    if (typeof context.inspectAuthIdentity !== "function") {
        throw new TypeError("auth scenario requires context.inspectAuthIdentity")
    }
    const before = await context.inspectAuthIdentity(identity)
    if (!validAuthState(before)) throw new Error("auth identity state is invalid before signup")
    const response = await postCnRequest(app, "/api/index.php/tool/signup", {
        device_id: identity.deviceId,
        channelNo: "performance_fixture",
    }, { udid: `performance-fixture-${identity.deviceId}` })
    const payload = requireSuccessfulCnResponse(response, "auth")
    const after = await context.inspectAuthIdentity(identity)
    if (!validAuthState(after)) throw new Error("auth identity state is invalid after signup")

    const deviceBindingPreserved = before.binding.device_id === identity.deviceId
        && after.binding.device_id === identity.deviceId
        && before.binding.account_id === identity.accountId
        && after.binding.account_id === identity.accountId
    const accountPreserved = hasExpectedViewerSession(before, identity)
        && hasExpectedViewerSession(after, identity)
    const viewerSessionCount = after.viewerSessions.length
    if (payload.data?.newAccount !== 0
        || !deviceBindingPreserved
        || !accountPreserved
        || viewerSessionCount !== 1) {
        throw new Error("auth identity session invariant violated")
    }
    return {
        entry: "auth",
        adapter: "fastify-route:/api/index.php/tool/signup",
        statusCode: response.statusCode,
        resultCode: payload.data_headers?.result_code,
        newAccount: payload.data.newAccount,
        deviceBindingPreserved,
        accountPreserved,
        viewerSessionCount,
    }
}

async function executeLoad(app, identity) {
    const response = await postCnRequest(app, "/api/index.php/load", {
        viewer_id: identity.viewerId,
        keychain: identity.viewerId,
        device_id: identity.deviceId,
        device_token: `performance-fixture-${identity.deviceId}`,
        graphics_device_name: "performance-fixture",
        platform_os_version: "test",
        storage_directory_path: "",
    }, { res_ver: LOAD_RES_VERSION })
    const payload = requireSuccessfulCnResponse(response, "load")
    if (payload.data_headers?.viewer_id !== identity.accountId) {
        throw new Error("load viewer_id must match the identity account")
    }
    if (payload.data_headers?.asset_update !== false) {
        throw new Error("load asset_update must be false in client-owned mode")
    }
    if (!isPlainObject(payload.data)) throw new Error("load data must be a plain object")
    const data = payload.data
    if (data.available_asset_version !== LOAD_RES_VERSION) {
        throw new Error(`load available_asset_version must be ${LOAD_RES_VERSION}`)
    }
    const characterList = requireLoadCollection(data, "character_list", {
        alias: "user_character_list",
    })
    const equipmentList = requireLoadCollection(data, "equipment_list", {
        alias: "user_equipment_list",
    })
    const itemList = requireLoadCollection(data, "item_list")
    const unfinishedQuestList = requireLoadCollection(data, "unfinished_quest_list", {
        arrayOnly: true,
    })
    const unfinishedMultiQuestList = requireLoadCollection(data, "unfinished_multi_quest_list", {
        arrayOnly: true,
    })
    return {
        entry: "load",
        adapter: "fastify-route:/api/index.php/load",
        statusCode: response.statusCode,
        resultCode: payload.data_headers?.result_code,
        responseViewerMatchesAccount: true,
        assetUpdate: false,
        availableAssetVersion: data.available_asset_version,
        characterCount: countCollection(characterList),
        equipmentCount: countCollection(equipmentList),
        itemCount: countCollection(itemList),
        unfinishedQuestCount: countCollection(unfinishedQuestList),
        unfinishedMultiQuestCount: countCollection(unfinishedMultiQuestList),
        ...(identity.activeMissionFixture
            ? createActiveMissionBehaviorSummary("load", data.all_active_mission_list)
            : {}),
    }
}

async function executeMissionProgress(app, identity) {
    const response = await postCnRequest(
        app,
        "/api/index.php/mission/get_mission_progress",
        {
            viewer_id: identity.viewerId,
            api_count: 1,
            category_list: [{ category: 1 }],
        },
    )
    const payload = requireSuccessfulCnResponse(response, "mission-progress")
    if (payload.data_headers?.viewer_id !== identity.viewerId) {
        throw new Error("mission-progress viewer_id must match the identity")
    }
    const missionProgressList = payload.data?.mission_progress_list
    if (!Array.isArray(missionProgressList) || missionProgressList.length === 0) {
        throw new Error("mission-progress mission_progress_list must be a non-empty array")
    }
    if (!missionProgressList.every(isValidMissionProgressElement)) {
        throw new Error("mission-progress element schema is invalid")
    }
    const progress = createMissionProgressSummary(missionProgressList)
    return {
        entry: "mission-progress",
        adapter: "fastify-route:/api/index.php/mission/get_mission_progress",
        statusCode: response.statusCode,
        resultCode: payload.data_headers?.result_code,
        responseViewerMatchesIdentity: true,
        ...progress,
    }
}

async function executeScenario(app, identity, context = {}) {
    const entry = identity?.entryName
    if (entry === "auth") return executeAuth(app, identity, context)
    if (entry === "load") return executeLoad(app, identity)
    if (entry === "mission-progress") return executeMissionProgress(app, identity)
    if (entry === "single-battle") {
        const behavior = await executeSingleBattleScenario(app, identity, context)
        if (!identity.activeMissionFixture
            || typeof context.inspectActiveMissionState !== "function") return behavior
        return {
            ...behavior,
            ...createActiveMissionBehaviorSummary(
                "single-battle",
                context.inspectActiveMissionState(identity),
            ),
        }
    }
    if (entry === "shop") return executeShopScenario(app, identity, context)
    if (entry === "mail") return executeMailScenario(app, identity, context)
    if (entry === "gacha") return executeGachaScenario(app, identity, context)
    throw new Error(`unsupported non-multi mixed scenario: ${String(entry)}`)
}

module.exports = { executeScenario }
