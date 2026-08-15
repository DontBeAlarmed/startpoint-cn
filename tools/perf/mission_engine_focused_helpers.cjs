"use strict"

const crypto = require("node:crypto")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const VIEWER_ID = 800000401

async function completeAsyncCleanup(primaryError, actions) {
    const cleanupErrors = []
    for (const action of actions) {
        try {
            await action()
        } catch (error) {
            cleanupErrors.push(error)
        }
    }
    if (primaryError !== null) {
        if (cleanupErrors.length > 0 && primaryError instanceof Error) {
            const cleanupCause = cleanupErrors.length === 1
                ? cleanupErrors[0]
                : new AggregateError(cleanupErrors, "Mission page cleanup failed")
            if (primaryError.cause === undefined) primaryError.cause = cleanupCause
            else primaryError.cleanupCause = cleanupCause
        }
        throw primaryError
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0]
    if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, "Mission page cleanup failed")
    }
}

async function requestMissionPage(runtime, categoryList, {
    fastifyFactory = Fastify,
} = {}) {
    let app = null
    let primaryError = null
    let result
    try {
        app = fastifyFactory({ logger: false })
        app.addHook("onSend", (_request, reply, payload, done) => {
            if (String(reply.getHeader("content-type") ?? "").includes("application/x-msgpack")) {
                done(null, pack(payload))
                return
            }
            done(null, payload)
        })
        await app.register(runtime.missionRoutes)
        await app.ready()
        const response = await app.inject({
            method: "POST",
            url: "/get_mission_progress",
            payload: {
                viewer_id: VIEWER_ID,
                api_count: 1,
                category_list: categoryList,
            },
        })
        if (response.statusCode !== 200) {
            throw new Error(`mission page failed with ${response.statusCode}: ${response.body}`)
        }
        result = { statusCode: response.statusCode, data: unpack(response.rawPayload).data }
    } catch (error) {
        primaryError = error
    }
    await completeAsyncCleanup(primaryError, [
        async () => { if (app) await app.close() },
    ])
    return result
}

function createMissionProgressSummary(missionProgressList) {
    const tuples = missionProgressList.map(mission => [
        mission.mission_category,
        mission.mission_id,
        mission.progress_value,
        mission.stage,
    ]).sort((left, right) => left[0] - right[0] || left[1] - right[1])
    return {
        missionProgressCount: tuples.length,
        missionProgressSha256: crypto.createHash("sha256")
            .update(JSON.stringify(tuples))
            .digest("hex"),
    }
}

module.exports = { VIEWER_ID, createMissionProgressSummary, requestMissionPage }
