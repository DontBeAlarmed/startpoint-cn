"use strict"

const {
    ENTRY_NAMES,
    FORMAL_ACTIVE_IDENTITIES,
    FORMAL_ENTRY_REQUESTS,
    FORMAL_INDEPENDENT_SAVES,
} = require("./non_multi_mixed_metrics.cjs")

const DEVICE_ID_BASE = 700000000
const VIEWER_ID_BASE = 800000000
const VIEWER_SESSION_TYPE = 2
const VIEWER_SESSION_EXPIRES = "1970-01-01T00:00:00.000Z"

function validatePoolSize(independentSaves, activeIdentities) {
    if (!Number.isSafeInteger(independentSaves)
        || independentSaves <= 0
        || !Number.isSafeInteger(activeIdentities)
        || activeIdentities <= 0) {
        throw new TypeError("independentSaves and activeIdentities must be positive safe integers")
    }
    if (activeIdentities > independentSaves) {
        throw new RangeError("activeIdentities cannot exceed independentSaves")
    }
    if (activeIdentities < ENTRY_NAMES.length) {
        throw new RangeError(`activeIdentities must be at least ${ENTRY_NAMES.length}`)
    }
}

function createIdentityPoolPlan({ independentSaves, activeIdentities } = {}) {
    validatePoolSize(independentSaves, activeIdentities)

    const formal = independentSaves === FORMAL_INDEPENDENT_SAVES
        && activeIdentities === FORMAL_ACTIVE_IDENTITIES
    const entryRequests = formal
        ? [...FORMAL_ENTRY_REQUESTS]
        : ENTRY_NAMES.map((_, index) => (
            Math.floor(activeIdentities / ENTRY_NAMES.length)
            + (index < activeIdentities % ENTRY_NAMES.length ? 1 : 0)
        ))
    const entryAssignments = []
    for (let entryIndex = 0; entryIndex < ENTRY_NAMES.length; entryIndex++) {
        for (let requestIndex = 0; requestIndex < entryRequests[entryIndex]; requestIndex++) {
            entryAssignments.push(ENTRY_NAMES[entryIndex])
        }
    }
    while (entryAssignments.length < independentSaves) entryAssignments.push(null)

    return Object.freeze({
        mode: formal ? "formal" : "smoke",
        entryRequests: Object.freeze(entryRequests),
        entryAssignments: Object.freeze(entryAssignments),
    })
}

function requireRuntime(dataApi) {
    const requiredFunctions = [
        "getDb",
        "insertAccountSync",
        "insertDefaultPlayerSync",
        "insertDeviceBindingSync",
    ]
    if (dataApi === null || typeof dataApi !== "object") {
        throw new TypeError("dataApi must provide the runtime data functions")
    }
    for (const name of requiredFunctions) {
        if (typeof dataApi[name] !== "function") {
            throw new TypeError(`dataApi.${name} must be a function`)
        }
    }
    return dataApi
}

function requirePositiveSafeId(id, name) {
    if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error(`${name} must be a positive safe integer`)
    }
    return id
}

function seedNonMultiMixedFixture(dataApi, profile) {
    const plan = createIdentityPoolPlan(profile)
    const runtime = requireRuntime(dataApi)
    const db = runtime.getDb()
    if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") {
        throw new TypeError("dataApi.getDb() must return an initialized database")
    }

    const insertViewerSession = db.prepare(`
        INSERT INTO sessions (token, account_id, expires, type)
        VALUES (?, ?, ?, ?)
    `)
    const inspectIdentityTables = db.prepare(`
        SELECT
            EXISTS(SELECT 1 FROM accounts) AS accounts,
            EXISTS(SELECT 1 FROM players) AS players,
            EXISTS(SELECT 1 FROM device_bindings) AS deviceBindings,
            EXISTS(SELECT 1 FROM sessions) AS sessions
    `)
    const seed = db.transaction(() => {
        const occupiedTables = Object.entries(inspectIdentityTables.get())
            .filter(([, occupied]) => occupied !== 0)
            .map(([table]) => table)
        if (occupiedTables.length > 0) {
            throw new Error(
                `mixed fixture requires empty identity tables: ${occupiedTables.join(", ")}`,
            )
        }

        return plan.entryAssignments.map((entryName, index) => {
            const deviceId = requirePositiveSafeId(DEVICE_ID_BASE + index + 1, "deviceId")
            const viewerId = requirePositiveSafeId(VIEWER_ID_BASE + index + 1, "viewerId")
            const account = runtime.insertAccountSync({
                appId: "wf_cn",
                idpAlias: "",
                idpCode: "performance_fixture",
                idpId: `non-multi-mixed-${deviceId}`,
                status: "normal",
            })
            const accountId = requirePositiveSafeId(account?.id, "accountId")
            const player = runtime.insertDefaultPlayerSync(accountId)
            const playerId = requirePositiveSafeId(player?.id, "playerId")

            runtime.insertDeviceBindingSync(deviceId, accountId)
            insertViewerSession.run(
                String(viewerId),
                accountId,
                VIEWER_SESSION_EXPIRES,
                VIEWER_SESSION_TYPE,
            )
            return Object.freeze({
                accountId,
                playerId,
                viewerId,
                deviceId,
                entryName,
                identityIndex: index,
            })
        })
    })

    const identities = seed()
    const activeIdentityCount = plan.entryRequests.reduce((total, count) => total + count, 0)
    const activeIdentities = identities.slice(0, activeIdentityCount)
    const inactiveIdentities = identities.slice(activeIdentityCount)
    return Object.freeze({
        mode: plan.mode,
        entryRequests: plan.entryRequests,
        identities: Object.freeze(identities),
        activeIdentities: Object.freeze(activeIdentities),
        inactiveIdentities: Object.freeze(inactiveIdentities),
    })
}

module.exports = {
    createIdentityPoolPlan,
    seedNonMultiMixedFixture,
}
