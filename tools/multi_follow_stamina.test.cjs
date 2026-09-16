"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
test.after(() => restoreContentSnapshot())

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-follow-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { addLocalFollowSync } = require("../src/data/domains/follow")
const {
    resolveRoomEstablisherFollowStateSync,
    isTrustedCrossServerGuest,
} = require("../src/multi/follow-policy")

data.initializeDatabase()

const participant = (nodeSessionId, viewerId) => ({ nodeSessionId, viewerId })
const LOCAL = "local-node"
const REMOTE = "remote-node"

function freshViewer(tag) {
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "test",
        idpId: `multi-follow-${tag}-${randomUUID()}`, status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 760000000 + playerId
    insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-12-31T23:59:59.000Z"),
        type: SessionType.VIEWER,
    })
    return { viewerId, playerId }
}

test.after(() => {
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

// ---- policy unit ----

test("same trusted node reads the real local relation", () => {
    const a = freshViewer("pol-a")
    const b = freshViewer("pol-b")
    const state = (extra = {}) => resolveRoomEstablisherFollowStateSync({
        requester: participant(LOCAL, a.viewerId),
        host: participant(LOCAL, b.viewerId),
        requesterPlayerId: a.playerId,
        hostPlayerId: b.playerId,
        ...extra,
    })
    assert.equal(state(), 0)
    addLocalFollowSync({ sourcePlayerId: a.playerId, targetPlayerId: b.playerId, followedAtMs: 1 })
    assert.equal(state(), 2)
    addLocalFollowSync({ sourcePlayerId: b.playerId, targetPlayerId: a.playerId, followedAtMs: 2 })
    assert.equal(state(), 1)
})

test("trusted cross-node guests project the compatibility state 1", () => {
    const a = freshViewer("cross-a")
    assert.equal(isTrustedCrossServerGuest({
        requester: participant(LOCAL, a.viewerId),
        host: participant(REMOTE, 42),
    }), true)
    assert.equal(resolveRoomEstablisherFollowStateSync({
        requester: participant(LOCAL, a.viewerId),
        host: participant(REMOTE, 42),
        requesterPlayerId: a.playerId,
        hostPlayerId: null,
    }), 1)
})

test("untrusted identities never earn the cross-server bonus", () => {
    const a = freshViewer("untrusted-a")
    for (const host of [participant("", 42), participant("remote-pending", 42)]) {
        assert.equal(isTrustedCrossServerGuest({
            requester: participant(LOCAL, a.viewerId),
            host,
        }), false)
        assert.equal(resolveRoomEstablisherFollowStateSync({
            requester: participant(LOCAL, a.viewerId),
            host,
            requesterPlayerId: a.playerId,
            hostPlayerId: null,
        }), 0)
    }
    assert.equal(isTrustedCrossServerGuest({
        requester: participant("remote-pending", a.viewerId),
        host: participant(REMOTE, 42),
    }), false)
})

// ---- endpoint projections ----

function roomStatus(host, viewerOfHost) {
    return {
        ok: true,
        value: {
            roomNumber: "123456",
            accessToken: "access-token",
            category: 1,
            questId: 701,
            hostEntryTime: 1_725_000_000,
            roomSequence: 1,
            raisingState: 1,
            shareRoomOptions: 0,
            hostMainCharacterId: 401,
            isNpcMode: false,
            hostOnline: true,
            host,
            members: [host],
            compatibility: {
                multiProtocolVersion: 1,
                APP_VER: "embedded",
                RES_VER: "embedded",
                cdnTargetVersion: "embedded",
                contentDigest: `sha256:${"0".repeat(64)}`,
                modeDigest: `sha256:${"0".repeat(64)}`,
            },
        },
    }
}

async function buildApp(host, requesterNode) {
    const { registerSocialRoutes } = require("../src/multi/http/social")
    const { registerLobbyRoutes } = require("../src/multi/http/lobby")
    const app = Fastify()
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    const status = roomStatus(host)
    const context = {
        coordinator: {
            selectRoom: async () => status,
            searchRoom: async () => status,
            getRoomStatus: async () => status,
        },
        resolvePlayerContext: async viewerId => {
            // host（本节点玩家）与请求者都按真实存档解析
            const { getPlayerSync } = require("../src/data/domains/player")
            const { resolvePlayerIdSync } = require("../src/data/activeAccount")
            const { getSessionSync } = require("../src/data/domains/session")
            const session = getSessionSync(String(viewerId))
            if (!session) return null
            const playerId = resolvePlayerIdSync(session.accountId)
            if (playerId === null) return null
            const player = getPlayerSync(playerId)
            return { playerId, player: { name: player?.name ?? "", rankPoint: player?.rankPoint ?? 0 } }
        },
        snapshotProvider: {
            getParticipant: viewerId => participant(requesterNode, viewerId),
            getCompatibility: () => ({ ok: true, value: status.value.compatibility }),
            prepareAdmission: async () => ({ snapshot: {} }),
        },
        questAvailability: { check: () => ({ available: true }) },
        admissionProvider: {},
        admissionIssuer: { issue: async () => ({ ok: true, value: {} }) },
        admissionTtlMs: 5_000,
        now: () => 1_000,
        settlementVerifier: {},
        tcpEndpoint: () => ({ host: "hub.example", port: 9103 }),
    }
    registerSocialRoutes(app, context)
    registerLobbyRoutes(app, context)
    await app.ready()
    return { app, context }
}

async function post(app, url, payload) {
    const response = await app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(payload).toString("base64"),
    })
    try {
        return unpack(Buffer.from(response.body, "base64"))
    } catch {
        throw new Error(`${url} -> ${response.statusCode}: ${response.body.slice(0, 200)}`)
    }
}

test("verify_access_token and check_room project the real same-node relation", async t => {
    const requester = freshViewer("ep-req")
    const host = freshViewer("ep-host")
    addLocalFollowSync({ sourcePlayerId: requester.playerId, targetPlayerId: host.playerId, followedAtMs: 1 })

    const { app } = await buildApp(participant(LOCAL, host.viewerId), LOCAL)
    t.after(() => app.close())

    const verify = await post(app, "/verify_access_token", {
        viewer_id: requester.viewerId, access_token: "access-token",
    })
    assert.equal(verify.data.room_exists, true)
    assert.equal(verify.data.establisher_follow, 2, "同节点单向关注 → 2")

    const check = await post(app, "/search_room", {
        viewer_id: requester.viewerId, room_number: "123456",
    })
    assert.equal(check.data.room_exists, true)
    assert.equal(check.data.establisher_follow, 2)
})

test("cross-node host keeps the compatibility projection 1 on both endpoints", async t => {
    const requester = freshViewer("ep-cross")
    const { app } = await buildApp(participant(REMOTE, 987654321), LOCAL)
    t.after(() => app.close())

    const verify = await post(app, "/verify_access_token", {
        viewer_id: requester.viewerId, access_token: "access-token",
    })
    assert.equal(verify.data.establisher_follow, 1, "可信跨服 → 兼容投影 1")

    const check = await post(app, "/search_room", {
        viewer_id: requester.viewerId, room_number: "123456",
    })
    assert.equal(check.data.establisher_follow, 1)
})
