"use strict"

const STAMINA_DATABASE_FIXTURE = "fixed-fixture-time"
const STAMINA_DATABASE_UPDATED = "within-request-window"
const STAMINA_RESPONSE_MATCH = "matches-database-virtual-time"

function dateMilliseconds(value, location) {
    if (value === null) throw new TypeError(`${location} is null`)
    if (typeof value === "number") throw new TypeError(`${location} is a number`)
    if (typeof value === "string") throw new TypeError(`${location} is a string`)
    if (!(value instanceof Date)) throw new TypeError(`${location} is not a Date`)
    const milliseconds = value.getTime()
    if (!Number.isFinite(milliseconds)) throw new TypeError(`${location} is Invalid Date`)
    return milliseconds
}

function safeInteger(value, location) {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${location} is not a safe integer`)
    return value
}

function validateTimeContext(context) {
    if (context === null || typeof context !== "object" || Array.isArray(context)) {
        throw new TypeError("stamina heal time context must be an object")
    }
    const beforeMs = dateMilliseconds(
        context.beforeDatabaseValue,
        "before database staminaHealTime",
    )
    const afterMs = dateMilliseconds(
        context.afterDatabaseValue,
        "database staminaHealTime",
    )
    const requestStartedAtMs = safeInteger(context.requestStartedAtMs, "request start")
    const requestEndedAtMs = safeInteger(context.requestEndedAtMs, "request end")
    const timeOffsetMs = safeInteger(context.timeOffsetMs, "time offset")
    if (requestEndedAtMs < requestStartedAtMs) {
        throw new RangeError("request time window is reversed")
    }
    if (afterMs !== beforeMs
        && (afterMs < requestStartedAtMs || afterMs > requestEndedAtMs)) {
        throw new RangeError("database staminaHealTime update is outside request window")
    }
    return { afterMs, timeOffsetMs }
}

function normalizeDynamicFields(value, context) {
    const { afterMs, timeOffsetMs } = validateTimeContext(context)
    const expectedResponse = Math.floor((afterMs + timeOffsetMs) / 1_000)

    function visit(current) {
        if (Array.isArray(current)) return current.map(visit)
        if (current === null || typeof current !== "object") return current
        return Object.fromEntries(Object.entries(current).map(([key, nested]) => {
            if (key === "servertime" || key === "start_time") {
                return [key, "fixed-server-time"]
            }
            if (key === "stamina_heal_time") {
                if (nested === null) throw new TypeError("response stamina_heal_time is null")
                if (!Number.isSafeInteger(nested)) {
                    throw new TypeError("response stamina_heal_time is not a safe integer")
                }
                if (nested !== expectedResponse) {
                    throw new RangeError("response stamina_heal_time does not match database virtual time")
                }
                return [key, STAMINA_RESPONSE_MATCH]
            }
            if (key === "exp_pooled_time") return [key, "fixture-pool-time"]
            if (key === "join_time" || key === "update_time" || key === "create_time") {
                return [key, "fixture-character-time"]
            }
            return [key, visit(nested)]
        }))
    }

    return visit(value)
}

function createStaminaHealTimeTracker(initialDatabaseValue) {
    let currentMs = dateMilliseconds(
        initialDatabaseValue,
        "fixture database staminaHealTime",
    )
    let databaseSemantic = STAMINA_DATABASE_FIXTURE
    return {
        normalizeRequest(value, context) {
            const beforeMs = dateMilliseconds(
                context.beforeDatabaseValue,
                "before database staminaHealTime",
            )
            if (beforeMs !== currentMs) {
                throw new RangeError("database staminaHealTime changed outside a captured request")
            }
            const normalized = normalizeDynamicFields(value, context)
            const afterMs = dateMilliseconds(
                context.afterDatabaseValue,
                "database staminaHealTime",
            )
            if (afterMs !== beforeMs) databaseSemantic = STAMINA_DATABASE_UPDATED
            currentMs = afterMs
            return normalized
        },
        summarizeDatabase(value) {
            const observedMs = dateMilliseconds(value, "database staminaHealTime")
            if (observedMs !== currentMs) {
                throw new RangeError("database staminaHealTime differs from captured request state")
            }
            return databaseSemantic
        },
    }
}

module.exports = {
    STAMINA_DATABASE_FIXTURE,
    STAMINA_DATABASE_UPDATED,
    createStaminaHealTimeTracker,
    normalizeDynamicFields,
}
