"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const sessionValidator = require("../src/lib/quest/finish/session-validator")

test("identity resolver returns session account and player id without loading Player", async () => {
    let getPlayerCalls = 0
    const result = await sessionValidator.validateSessionIdentity(800000026, {
        getSession: async viewerId => {
            assert.equal(viewerId, "800000026")
            return { accountId: 41 }
        },
        resolvePlayerId: accountId => {
            assert.equal(accountId, 41)
            return 73
        },
        getPlayer: () => {
            getPlayerCalls++
            throw new Error("identity resolver must not load Player")
        },
    })

    assert.deepEqual(result, { accountId: 41, playerId: 73 })
    assert.equal(getPlayerCalls, 0)
})

test("identity resolver fails closed without a session or player id", async t => {
    await t.test("missing session", async () => {
        let resolveCalls = 0
        const result = await sessionValidator.validateSessionIdentity(800000026, {
            getSession: async () => null,
            resolvePlayerId: () => {
                resolveCalls++
                return 73
            },
        })
        assert.equal(result, null)
        assert.equal(resolveCalls, 0)
    })

    await t.test("missing player id", async () => {
        const result = await sessionValidator.validateSessionIdentity(800000026, {
            getSession: async () => ({ accountId: 41 }),
            resolvePlayerId: () => null,
        })
        assert.equal(result, null)
    })

    for (const viewerId of [0, Number.NaN]) {
        await t.test(`invalid viewer ${viewerId}`, async () => {
            let sessionCalls = 0
            const result = await sessionValidator.validateSessionIdentity(viewerId, {
                getSession: async () => {
                    sessionCalls++
                    return { accountId: 41 }
                },
                resolvePlayerId: () => 73,
            })
            assert.equal(result, null)
            assert.equal(sessionCalls, 0)
        })
    }
})

test("single battle routes keep finish full and entry routes identity-only", () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, "../src/routes/api/singleBattleQuest.ts"),
        "utf8",
    )
    function routeBlock(route, nextRoute) {
        const start = source.indexOf(`fastify.post("/${route}"`)
        const end = nextRoute ? source.indexOf(`fastify.post("/${nextRoute}"`, start) : source.length
        assert.ok(start >= 0, route)
        assert.ok(end > start, route)
        return source.slice(start, end)
    }

    const finish = routeBlock("finish", "abort")
    assert.match(finish, /validateSessionAndPlayer\(viewerId\)/)
    assert.doesNotMatch(finish, /validateSessionIdentity\(viewerId\)/)

    for (const [route, nextRoute] of [
        ["abort", "start"],
        ["start", "play_continue"],
        ["play_continue", null],
    ]) {
        const block = routeBlock(route, nextRoute)
        assert.match(block, /validateSessionIdentity\(viewerId\)/, route)
        assert.doesNotMatch(block, /validateSessionAndPlayer\(viewerId\)/, route)
    }

    const abort = routeBlock("abort", "start")
    assert.doesNotMatch(abort, /getPlayerActiveQuestSync\(/)
    assert.match(abort, /abortResult\.resolvedIdentity/)
    assert.match(abort, /abortResult\.observedActiveQuest/)

    const start = routeBlock("start", "play_continue")
    assert.doesNotMatch(start, /playerData/)
    assert.match(start, /startResult\.beforeStamina/)
})
